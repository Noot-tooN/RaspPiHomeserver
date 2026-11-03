{
  config,
  lib,
  pkgs,
  ...
}:
{
  imports = [
    ./hardware.nix
    ../../modules/network.nix
    ../../modules/tailscale.nix
    ../../modules/control-panel.nix
    ../../modules/audio.nix
    ../../modules/spotify.nix
    ../../modules/youtube.nix
    ../../modules/updates.nix
  ];

  networking.hostName = "rasppi";
  time.timeZone = "Europe/Belgrade";
  i18n.defaultLocale = "en_US.UTF-8";
  system.stateVersion = "26.05";

  users.users.pita = {
    isNormalUser = true;
    uid = 1000;
    linger = true;
    extraGroups = [
      "wheel"
      "audio"
      "video"
      "networkmanager"
    ];
    openssh.authorizedKeys.keyFiles = [ ../../keys/pita.pub ];
  };
  # The image has no password credentials; administration uses the existing SSH key.
  security.sudo.wheelNeedsPassword = false;
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  nix.settings = {
    experimental-features = [
      "nix-command"
      "flakes"
    ];
    max-jobs = 1;
    cores = 2;
    auto-optimise-store = true;
  };
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };
  zramSwap.enable = true;
  zramSwap.memoryPercent = 100;
  boot.tmp.useTmpfs = true;
  environment.systemPackages = with pkgs; [
    alsa-utils
    pulseaudio
    curl
    git
    vim
  ];
  documentation.nixos.enable = false;
}
