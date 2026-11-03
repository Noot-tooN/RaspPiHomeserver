{ pkgs, ... }:
{
  # Raspotify is a distro wrapper around librespot. Preserve its effective
  # backend, normalization and disabled caches directly, without rebuilding it.
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
      ExecStart = "${pkgs.librespot}/bin/librespot --name RaspPi --backend pulseaudio --enable-volume-normalisation --disable-audio-cache --disable-credential-cache --zeroconf-port 24879";
      Restart = "always";
      RestartSec = 10;
      UMask = "0077";
    };
  };
}
