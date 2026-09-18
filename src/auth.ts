import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
  invalidate(): boolean;
}

abstract class CachedAccessTokenProvider implements AccessTokenProvider {
  private cachedToken: string | null = null;

  async getAccessToken(): Promise<string> {
    if (!this.cachedToken) {
      this.cachedToken = await this.issueAccessToken();
    }
    return this.cachedToken;
  }

  invalidate(): boolean {
    if (!this.canRefresh) return false;
    this.cachedToken = null;
    return true;
  }

  protected abstract readonly canRefresh: boolean;
  protected abstract issueAccessToken(): Promise<string>;
}

class StaticAccessTokenProvider extends CachedAccessTokenProvider {
  protected readonly canRefresh = false;

  constructor(private readonly token: string) {
    super();
  }

  protected async issueAccessToken(): Promise<string> {
    return this.token;
  }
}

class BootstrapAccessTokenProvider extends CachedAccessTokenProvider {
  protected readonly canRefresh = false;

  constructor(
    private readonly baseUrl: string,
    private readonly credential: string,
  ) {
    super();
  }

  protected issueAccessToken(): Promise<string> {
    return exchangeBootstrapCredential(this.baseUrl, this.credential);
  }
}

class LocalPairingAccessTokenProvider extends CachedAccessTokenProvider {
  protected readonly canRefresh = true;

  constructor(
    private readonly baseUrl: string,
    private readonly t3Command: string,
    private readonly baseDir: string,
    private readonly ttl: string,
    private readonly label: string,
  ) {
    super();
  }

  protected async issueAccessToken(): Promise<string> {
    const { stdout } = await execFileAsync(
      this.t3Command,
      [
        "auth",
        "pairing",
        "create",
        "--base-dir",
        this.baseDir,
        "--ttl",
        this.ttl,
        "--label",
        this.label,
        "--json",
      ],
      {
        env: {
          ...process.env,
          T3CODE_HOME: this.baseDir,
        },
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new Error(
        `T3 Code CLI returned invalid pairing JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const credential =
      parsed &&
      typeof parsed === "object" &&
      "credential" in parsed &&
      typeof (parsed as { credential?: unknown }).credential === "string"
        ? (parsed as { credential: string }).credential
        : null;

    if (!credential) {
      throw new Error("T3 Code CLI pairing response did not include a credential");
    }

    return exchangeBootstrapCredential(this.baseUrl, credential);
  }
}

async function readSecretFile(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`Secret file is empty: ${path}`);
  return value;
}

async function exchangeBootstrapCredential(baseUrl: string, credential: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: credential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
  });

  const response = await fetch(new URL("/oauth/token", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`T3 Code token exchange failed (${response.status}): ${detail}`);
  }

  const data = (await response.json()) as { access_token?: unknown };
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("T3 Code token exchange response did not include access_token");
  }

  return data.access_token;
}

export async function accessTokenProviderFromEnvironment(
  baseUrl: string,
): Promise<AccessTokenProvider> {
  const accessToken =
    process.env.T3_CODE_ACCESS_TOKEN ??
    (process.env.T3_CODE_ACCESS_TOKEN_FILE
      ? await readSecretFile(process.env.T3_CODE_ACCESS_TOKEN_FILE)
      : undefined);
  if (accessToken) {
    return new StaticAccessTokenProvider(accessToken);
  }

  const bootstrapToken =
    process.env.T3_CODE_TOKEN ??
    (process.env.T3_CODE_TOKEN_FILE
      ? await readSecretFile(process.env.T3_CODE_TOKEN_FILE)
      : undefined);
  if (bootstrapToken) {
    return new BootstrapAccessTokenProvider(baseUrl, bootstrapToken);
  }

  const baseDir = process.env.T3_CODE_BASE_DIR;
  if (baseDir) {
    return new LocalPairingAccessTokenProvider(
      baseUrl,
      process.env.T3_CODE_CLI ?? "t3",
      baseDir,
      process.env.T3_CODE_PAIRING_TTL ?? "5m",
      process.env.T3_CODE_PAIRING_LABEL ?? "t3code-mcp",
    );
  }

  throw new Error(
    "No T3 authentication configured. Set T3_CODE_ACCESS_TOKEN, T3_CODE_TOKEN, " +
      "or T3_CODE_BASE_DIR for local pairing.",
  );
}
