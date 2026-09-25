{ config, lib, pkgs, ... }:

let
  cfg = config.services.t3code-mcp;
in
{
  options.services.t3code-mcp = {
    enable = lib.mkEnableOption "T3 Code MCP bridge";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = "t3code-mcp package to run.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "t3code-mcp";
      description = "User account used by the service.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "t3code-mcp";
      description = "Group used by the service.";
    };

    createUser = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Create the configured system user and group.";
    };

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address for the Streamable HTTP MCP listener.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8732;
      description = "Port for the Streamable HTTP MCP listener.";
    };

    endpointPath = lib.mkOption {
      type = lib.types.str;
      default = "/mcp";
      description = "HTTP path serving the MCP endpoint.";
    };

    t3Url = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:3000";
      description = "Base URL of the T3 Code server.";
    };

    t3BaseDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/var/lib/t3code";
      description = ''
        Local T3 Code base directory. When set, t3code-mcp mints a standard
        one-time pairing credential through the T3 CLI and exchanges it for a
        bearer session. This avoids storing a long-lived MCP credential.
      '';
    };

    t3Command = lib.mkOption {
      type = lib.types.str;
      default = "t3";
      description = "T3 Code CLI executable used for local pairing.";
    };

    pairingTtl = lib.mkOption {
      type = lib.types.str;
      default = "5m";
      description = "TTL passed to the local T3 pairing credential.";
    };

    pairingLabel = lib.mkOption {
      type = lib.types.str;
      default = "t3code-mcp";
      description = "Label attached to locally minted T3 pairing credentials.";
    };

    antigravityCommand = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/current-system/sw/bin/agy";
      description = ''
        Antigravity CLI for the usage probe of t3_get_usage_limits. The probe
        runs `agy --print /usage --output-format json` as the service user, so
        that user needs its own Antigravity authentication state. ProtectHome
        hides /home, so a user with its home under /home cannot use the probe.
        Null disables the probe.
      '';
    };

    opencodeGoApiKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/opencode-zen-api-key";
      description = ''
        File with the OpenCode Go API key for the usage probe of
        t3_get_usage_limits. systemd passes it to the service with
        LoadCredential, so the service user does not need read access to the
        file. Null disables the probe.
      '';
    };

    after = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Additional systemd units this service starts after.";
    };

    requires = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Additional systemd units required by this service.";
    };

    extraEnvironment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Additional environment variables for t3code-mcp.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.hasPrefix "/" cfg.endpointPath;
        message = "services.t3code-mcp.endpointPath must start with '/'.";
      }
      {
        assertion = cfg.t3BaseDir != null;
        message = ''
          services.t3code-mcp.t3BaseDir must be set for the native service.
          Run the binary directly if you want to provide an external token instead.
        '';
      }
    ];

    users.groups = lib.mkIf cfg.createUser {
      ${cfg.group} = { };
    };

    users.users = lib.mkIf cfg.createUser {
      ${cfg.user} = {
        isSystemUser = true;
        group = cfg.group;
      };
    };

    systemd.services.t3code-mcp = {
      description = "T3 Code MCP bridge";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ] ++ cfg.after;
      requires = cfg.requires;

      environment = {
        MCP_TRANSPORT = "http";
        MCP_HTTP_HOST = cfg.listenAddress;
        MCP_HTTP_PORT = toString cfg.port;
        MCP_HTTP_PATH = cfg.endpointPath;
        T3_CODE_URL = cfg.t3Url;
        T3_CODE_BASE_DIR = cfg.t3BaseDir;
        T3_CODE_CLI = cfg.t3Command;
        T3_CODE_PAIRING_TTL = cfg.pairingTtl;
        T3_CODE_PAIRING_LABEL = cfg.pairingLabel;
        T3_USAGE_ANTIGRAVITY_CLI = if cfg.antigravityCommand == null then "off" else cfg.antigravityCommand;
      } // cfg.extraEnvironment;

      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        ExecStart = lib.getExe cfg.package;
        # usage.ts reads $CREDENTIALS_DIRECTORY/opencode-go-api-key.
        LoadCredential = lib.optional (cfg.opencodeGoApiKeyFile != null)
          "opencode-go-api-key:${cfg.opencodeGoApiKeyFile}";
        Restart = "on-failure";
        RestartSec = 5;

        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        CapabilityBoundingSet = [ ];
        ProtectControlGroups = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
        SystemCallArchitectures = "native";
        ReadWritePaths = lib.optional (cfg.t3BaseDir != null) cfg.t3BaseDir;
        UMask = "0077";
      };
    };
  };
}
