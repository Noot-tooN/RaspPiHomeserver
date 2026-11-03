{ config, pkgsUnstable, ... }:
{
  # Match HomeServer: Tailscale provides the network; OpenSSH checks SSH keys.
  services.tailscale = {
    enable = true;
    package = pkgsUnstable.tailscale;
    useRoutingFeatures = "client";
    openFirewall = true;
    extraUpFlags = [ "--ssh=false" ];
    extraSetFlags = [ "--ssh=false" ];
    authKeyFile = "/etc/tailscale/authkey";
  };

  networking.firewall.trustedInterfaces = [ config.services.tailscale.interfaceName ];

  # Fresh images contain no enrollment secret. LAN SSH remains available so the
  # owner can either log in interactively or provision this root-only file.
  systemd.services.tailscaled-autoconnect.unitConfig.ConditionPathExists =
    config.services.tailscale.authKeyFile;
}
