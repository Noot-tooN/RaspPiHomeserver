{
  description = "Raspberry Pi 4 Spotify Connect and YouTube receiver";

  inputs = {
    # Follow the Pi project's exact package set to preserve its kernel cache hits.
    nixos-raspberrypi.url = "github:nvmd/nixos-raspberrypi/main";
    nixpkgs.follows = "nixos-raspberrypi/nixpkgs";
    # Match HomeServer: newer Tailscale fixes without changing the Pi kernel pin.
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    comin = {
      url = "github:nlewo/comin";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  nixConfig = {
    extra-substituters = [ "https://nixos-raspberrypi.cachix.org" ];
    extra-trusted-public-keys = [
      "nixos-raspberrypi.cachix.org-1:4iMO9LXa8BqhU+Rpg6LQKiGa2lsNh/j2oiYLNOQ5sPI="
    ];
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-unstable,
      nixos-raspberrypi,
      comin,
      ...
    }:
    let
      system = "aarch64-linux";
      host = nixos-raspberrypi.lib.nixosSystem {
        specialArgs.pkgsUnstable = import nixpkgs-unstable { inherit system; };
        modules = [
          nixos-raspberrypi.nixosModules.raspberry-pi-4.base
          nixos-raspberrypi.nixosModules.sd-image
          comin.nixosModules.comin
          ./hosts/rasppi
        ];
      };
      pkgs = host.pkgs;
    in
    {
      nixosConfigurations.rasppi = host;
      packages.${system} = {
        default = host.config.system.build.sdImage;
        sd-image = host.config.system.build.sdImage;
        system = host.config.system.build.toplevel;
        control-panel = pkgs.callPackage ./apps/control-panel/package.nix { };
      };
      formatter.${system} = pkgs.nixfmt-tree;
      checks.${system} = {
        dashboard = pkgs.runCommand "dashboard-config-check" { nativeBuildInputs = [ pkgs.caddy ]; } ''
          export HOME=$TMPDIR
          # Keep the actual routes/TLS settings; only move access logs into the sandbox.
          sed "s|/var/log/caddy/|$TMPDIR/caddy-logs/|g" ${host.config.services.caddy.configFile} > Caddyfile
          caddy adapt --config Caddyfile --adapter caddyfile --validate > /dev/null
          touch $out
        '';
        receiver =
          pkgs.runCommand "receiver-tests"
            {
              nativeBuildInputs = [
                (pkgs.python3.withPackages (ps: [ ps.websockets ]))
                pkgs.nodejs
                pkgs.networkmanager
              ];
            }
            ''
              cp -r ${./scripts} scripts
              cp -r ${./tests} tests
              cp -r ${./youtube} youtube
              python -m unittest discover -s tests -v
              node tests/receiver-name.test.cjs
              touch $out
            '';
        control-panel = self.packages.${system}.control-panel;
      };
      # These are store paths, not builds. The cache check fails before CI starts
      # an expensive compilation if one of these pinned outputs is missing.
      lib.cachePaths = {
        caddy = pkgs.caddy.outPath;
        homer = pkgs.homer.outPath;
        kernel = host.config.boot.kernelPackages.kernel.outPath;
        kernel-modules = host.config.boot.kernelPackages.kernel.modules.outPath;
        firmware = host.config.boot.loader.raspberry-pi.firmwarePackage.outPath;
        brave = pkgs.brave.outPath;
        librespot = pkgs.librespot.outPath;
        pipewire = pkgs.pipewire.outPath;
        wireplumber = pkgs.wireplumber.outPath;
        xvfb = pkgs.xvfb.outPath;
        tailscale = host.config.services.tailscale.package.outPath;
      };
    };
}
