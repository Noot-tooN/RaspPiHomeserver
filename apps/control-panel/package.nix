{ buildGoModule, lib }:
buildGoModule {
  pname = "rasppi-control-panel";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      (lib.fileset.fileFilter (file: file.hasExt "go") ./.)
      ./go.mod
      ./web
    ];
  };
  vendorHash = null;
  env.CGO_ENABLED = "0";
  ldflags = [
    "-s"
    "-w"
  ];
  # The module's last path component is control-panel; expose a distinct command.
  postInstall = ''
    mv $out/bin/control-panel $out/bin/rasppi-control-panel
  '';
  doCheck = true;
  # buildGoModule removes -trimpath before tests. These tests use embedded
  # assets, so keep it to reuse the standard-library objects from buildPhase.
  checkFlags = [ "-trimpath" ];
}
