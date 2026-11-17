{ config, pkgs, ... }:
let
  ready = pkgs.writeShellApplication {
    name = "rasppi-audio-ready";
    runtimeInputs = [
      pkgs.pulseaudio
      pkgs.coreutils
      pkgs.gawk
    ];
    text = ''
      for _ in $(seq 1 90); do
        if [ -e /run/rasppi-dac/ready ] &&
           pactl list short sinks | awk '$2 == "rasppi-dac" { dac=1 } $2 == "rasppi-eq" { eq=1 } END { exit !(dac && eq) }'; then
          pactl set-default-sink rasppi-eq
          exit 0
        fi
        sleep 1
      done
      echo "DAC Pro or PipeWire sink did not become ready" >&2
      exit 1
    '';
  };
in
{
  imports = [ ./equalizer.nix ];
  security.rtkit.enable = true;
  services.pulseaudio.enable = false;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    pulse.enable = true;
    wireplumber.enable = true;
    extraConfig.pipewire."10-rasppi-clock" = {
      "context.properties" = {
        "default.clock.rate" = 48000;
        "default.clock.allowed-rates" = [ 48000 ];
      };
    };
    wireplumber.extraConfig."10-dac-pro" = {
      # Let WirePlumber save and restore software volume and mute per device route.
      # Its default volume applies only when that route has no saved state yet.
      "wireplumber.settings"."device.restore-routes" = true;
      "monitor.alsa.rules" = [
        {
          matches = [ { "device.name" = "alsa_card.platform-soc_sound"; } ];
          actions.update-props."api.alsa.soft-mixer" = true;
        }
        {
          matches = [ { "node.name" = "~alsa_output.platform-soc_sound.*"; } ];
          actions.update-props = {
            "node.name" = "rasppi-dac";
            "node.description" = "Raspberry Pi DAC Pro";
            "priority.session" = 2000;
          };
        }
      ];
    };
  };

  systemd.services.rasppi-dac-mixer = {
    description = "Restore the audited DAC Pro mixer state";
    wantedBy = [ "multi-user.target" ];
    after = [ "sound.target" ];
    path = [
      pkgs.alsa-utils
      pkgs.coreutils
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      RuntimeDirectory = "rasppi-dac";
      RuntimeDirectoryMode = "0755";
      # Stopping the mixer does not undo its hardware settings. NixOS restarts
      # user units before restarting this system unit; retain readiness across
      # that gap. /run still clears it on every boot, and ExecStart invalidates
      # it before attempting to restore the mixer again.
      RuntimeDirectoryPreserve = "yes";
      TimeoutStartSec = 100;
    };
    script = ''
      rm -f /run/rasppi-dac/ready
      for _ in $(seq 1 60); do
        if amixer -c Pro info >/dev/null 2>&1; then
          alsactl --no-init-fallback -f ${../hardware/dac-pro.state} restore Pro
          touch /run/rasppi-dac/ready
          exit 0
        fi
        sleep 1
      done
      echo "ALSA card Pro not detected; check the rpi-dacpro overlay" >&2
      exit 1
    '';
  };

  systemd.user.services.rasppi-audio-ready = {
    description = "Wait for the DAC and select the playback sink";
    requires = [
      "rasppi-equalizer.service"
      "pipewire-pulse.service"
      "wireplumber.service"
    ];
    after = [
      "rasppi-equalizer.service"
      "pipewire-pulse.service"
      "wireplumber.service"
    ];
    unitConfig = {
      ConditionUser = "pita";
      StartLimitIntervalSec = 0;
    };
    environment.PULSE_SERVER = "unix:%t/pulse/native";
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${ready}/bin/rasppi-audio-ready";
      TimeoutStartSec = 100;
    };
  };

  # Restart=always does not retry a unit whose start job failed because of a
  # dependency. Probe actual sinks as well as service states and retry those
  # jobs without blocking system activation or disturbing healthy playback.
  systemd.user.services.rasppi-audio-recovery = {
    description = "Recover audio outputs and receivers after dependency failures";
    unitConfig.ConditionUser = "pita";
    environment.PULSE_SERVER = "unix:%t/pulse/native";
    path = [
      pkgs.systemd
      pkgs.pulseaudio
    ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.python3}/bin/python ${../scripts/audio_recovery.py}";
      TimeoutStartSec = 20;
    };
  };
  systemd.user.timers.rasppi-audio-recovery = {
    description = "Check audio output and receiver recovery";
    wantedBy = [ "timers.target" ];
    unitConfig.ConditionUser = "pita";
    timerConfig = {
      OnBootSec = "30s";
      OnUnitInactiveSec = "15s";
      AccuracySec = "1s";
    };
  };
}
