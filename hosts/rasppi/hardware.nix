{ lib, ... }:
{
  disabledModules = [ "profiles/all-hardware.nix" ];
  boot.supportedFilesystems = lib.mkForce [
    "ext4"
    "vfat"
  ];
  boot.loader.raspberry-pi = {
    bootloader = "kernel";
    configurationLimit = 5;
  };
  # Use the vendor overlay from the same firmware bundle as the cached kernel.
  # No kernel compilation or NixOS build-time device-tree merge is required.
  hardware.raspberry-pi.config.all = {
    options.force_eeprom_read = {
      enable = true;
      value = 0;
    };
    dt-overlays.rpi-dacpro.enable = true;
    base-dt-params.audio = {
      enable = true;
      value = lib.mkForce "off";
    };
  };
  boot.kernelModules = [
    "bfq"
    "snd_soc_iqaudio_dac"
    "i2c-dev"
  ];
  # Pi firmware prepends cgroup_disable=memory. The vendor kernel accepts this
  # later override; memory accounting is also needed for buffered-I/O limits.
  boot.kernelParams = [ "cgroup_enable=memory" ];
  services.udev.extraRules = ''
    ACTION=="add|change", SUBSYSTEM=="block", KERNEL=="mmcblk[0-9]", ATTR{queue/scheduler}="bfq"
  '';
  # The image's filesystem labels are also used by Comin's installed generations.
  fileSystems."/boot/firmware".options = lib.mkForce [
    "noatime"
    "umask=0077"
  ];
  sdImage.compressImage = true;
}
