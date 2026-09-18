{ lib, buildNpmPackage, importNpmLock }:

let
  src = lib.cleanSource ../.;
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
in
buildNpmPackage {
  pname = packageJson.name;
  version = packageJson.version;
  inherit src;

  npmDeps = importNpmLock { npmRoot = src; };
  npmConfigHook = importNpmLock.npmConfigHook;
  npmBuildScript = "build";

  meta = {
    description = "MCP server for controlling T3 Code";
    homepage = "https://github.com/JuanDelPueblo/t3code-mcp";
    license = lib.licenses.mit;
    mainProgram = "t3code-mcp";
    platforms = lib.platforms.linux;
  };
}
