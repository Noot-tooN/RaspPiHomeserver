{ buildGoModule }:
buildGoModule {
  pname = "rasppi-control-panel";
  version = "0.1.0";
  src = ./.;
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
}
