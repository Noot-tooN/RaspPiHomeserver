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
    "snd_soc_iqaudio_dac"
    "i2c-dev"
  ];
  # The image's filesystem labels are also used by Comin's installed generations.
  fileSystems."/boot/firmware".options = lib.mkForce [
    "noatime"
    "umask=0077"
  ];
  sdImage.compressImage = true;
}
