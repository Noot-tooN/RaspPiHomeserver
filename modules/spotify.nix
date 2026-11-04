{ pkgs, pkgsUnstable, ... }:
let
  settings = (pkgs.formats.yaml { }).generate "spotify-config.yml" {
    device_name = "RaspPi";
    device_type = "speaker";
    audio_backend = "pulseaudio";
    audio_backend_runtime_socket = "/run/user/1000/pulse/native";
    audio_device = "rasppi-dac";
    normalisation_disabled = false;
    zeroconf_port = 24879;
    credentials = {
      type = "zeroconf";
      zeroconf.persist_credentials = false;
    };
    volume_steps = 100;
    initial_volume = 50;
    ignore_last_volume = false;
    server = {
      enabled = true;
      address = "127.0.0.1";
      port = 3678;
    };
  };
in
{
  # Cached upstream ARM64 package; its local API provides native Spotify
  # volume and transport controls without a Spotify developer account/token.
  systemd.user.services.spotify = {
    description = "Spotify Connect on the DAC Pro";
    wantedBy = [ "default.target" ];
    requires = [ "rasppi-audio-ready.service" ];
    after = [ "rasppi-audio-ready.service" ];
    unitConfig = {
      ConditionUser = "pita";
      StartLimitIntervalSec = 0;
    };
    environment = {
      PULSE_SERVER = "unix:%t/pulse/native";
      PULSE_SINK = "rasppi-dac";
      TMPDIR = "/tmp";
    };
    serviceConfig = {
      StateDirectory = "rasppi-spotify";
      StateDirectoryMode = "0700";
      ExecStartPre = "${pkgs.coreutils}/bin/install -m 600 ${settings} %S/rasppi-spotify/config.yml";
      ExecStart = "${pkgsUnstable.go-librespot}/bin/go-librespot -config_dir %S/rasppi-spotify";
      Restart = "always";
      RestartSec = 10;
      UMask = "0077";
    };
  };
  # The receiver API stays on loopback; only the panel's protected operations
  # are reachable through the existing HTTPS /audio/ route.
}
