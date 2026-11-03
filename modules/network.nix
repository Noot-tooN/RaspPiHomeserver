{ pkgs, ... }:
{
  networking.networkmanager.enable = true;
  networking.firewall.enable = true;
  # Librespot's discovery HTTP endpoint is fixed instead of choosing a random port.
  networking.firewall.allowedTCPPorts = [
    22
    24879
  ];
  services.avahi = {
    enable = true;
    nssmdns4 = true;
    openFirewall = true;
    publish = {
      enable = true;
      addresses = true;
    };
  };

  # Import a standard NetworkManager keyfile supplied AFTER flashing. The image
  # and Nix store never contain the Wi-Fi password. Ethernet also works via DHCP.
  systemd.services.rasppi-wifi-import = {
    description = "Import Wi-Fi provisioning file from the boot card";
    before = [ "NetworkManager.service" ];
    unitConfig = {
      RequiresMountsFor = "/boot/firmware";
      ConditionPathExists = "/boot/firmware/rasppi-wifi.nmconnection";
    };
    serviceConfig = {
      Type = "oneshot";
      UMask = "0077";
    };
    path = [ pkgs.coreutils ];
    script = ''
      destination=/etc/NetworkManager/system-connections/rasppi-wifi.nmconnection
      install -D -m 0600 /boot/firmware/rasppi-wifi.nmconnection "$destination.new"
      mv "$destination.new" "$destination"
      rm /boot/firmware/rasppi-wifi.nmconnection
    '';
  };
  systemd.services.NetworkManager.wants = [ "rasppi-wifi-import.service" ];
}
