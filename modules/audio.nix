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
           pactl list short sinks | awk '$2 == "rasppi-dac" { found=1 } END { exit !found }'; then
          pactl set-default-sink rasppi-dac
          pactl set-sink-volume rasppi-dac 40%
          pactl set-sink-mute rasppi-dac 0
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
    description = "Wait for the DAC and establish boot volume";
    requires = [
      "pipewire-pulse.service"
      "wireplumber.service"
    ];
    after = [
      "pipewire-pulse.service"
      "wireplumber.service"
    ];
    unitConfig.ConditionUser = "pita";
    environment.PULSE_SERVER = "unix:%t/pulse/native";
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${ready}/bin/rasppi-audio-ready";
      TimeoutStartSec = 100;
    };
  };
}
