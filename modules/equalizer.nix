{ pkgs, lib, ... }:
let
  bands =
    lib.imap0
      (i: freq: {
        type = "builtin";
        name = "band${toString i}";
        label = "bq_peaking";
        control = {
          Freq = freq;
          Q = 1.414;
          Gain = 0.0;
        };
      })
      [
        31.5
        63
        125
        250
        500
        1000
        2000
        4000
        8000
        16000
      ];
  nodes = [
    {
      type = "builtin";
      name = "preamp";
      label = "linear";
      control.Mult = 1.0;
    }
  ]
  ++ bands;
  fragment = pkgs.writeText "equalizer.json" (
    builtins.toJSON {
      "context.modules" = [
        {
          name = "libpipewire-module-filter-chain";
          args = {
            "node.description" = "RaspPi equalizer";
            "audio.channels" = 2;
            "audio.position" = [
              "FL"
              "FR"
            ];
            "filter.graph" = {
              inherit nodes;
              links = lib.imap0 (i: band: {
                output = "${(builtins.elemAt nodes i).name}:Out";
                input = "${band.name}:In";
              }) bands;
            };
            "capture.props" = {
              "node.name" = "rasppi-eq";
              "media.class" = "Audio/Sink";
            };
            "playback.props" = {
              "node.name" = "rasppi-eq-output";
              "node.passive" = true;
              "target.object" = "rasppi-dac";
              "node.dont-fallback" = true;
            };
          };
        }
      ];
    }
  );
  start = pkgs.writeShellScript "start-equalizer" ''
    set -eu
    # PipeWire's Type=simple unit is active before it accepts clients. Starting
    # a filter at that point can leave a live process with no sink. Wait for
    # the real DAC output, not just the daemon process, before connecting.
    ready=0
    for _ in $(${pkgs.coreutils}/bin/seq 1 15); do
      if ${pkgs.coreutils}/bin/timeout 3 ${pkgs.pulseaudio}/bin/pactl list short sinks |
         ${pkgs.gawk}/bin/awk '$2 == "rasppi-dac" { found=1 } END { exit !found }'; then
        ready=1
        break
      fi
      ${pkgs.coreutils}/bin/sleep 1
    done
    if [ "$ready" != 1 ]; then
      echo "Waiting for PipeWire DAC output before starting the equalizer" >&2
      exit 1
    fi
    export PIPEWIRE_CONFIG_DIR="$RUNTIME_DIRECTORY"
    ${pkgs.coreutils}/bin/mkdir -p "$RUNTIME_DIRECTORY/filter-chain.conf.d"
    ${pkgs.coreutils}/bin/cp ${pkgs.pipewire}/share/pipewire/filter-chain.conf "$RUNTIME_DIRECTORY/"
    curve="$STATE_DIRECTORY/equalizer.json"
    if [ ! -f "$curve" ]; then curve=/dev/null; fi
    ${pkgs.jq}/bin/jq --slurpfile saved "$curve" '
      if ($saved | length) == 0 then . else
        ."context.modules"[0].args."filter.graph".nodes |=
        (.[0].control.Mult = $saved[0].preamp |
         reduce range(0;10) as $i (. ; .[$i+1].control.Gain = $saved[0].gains[$i]))
      end
    ' ${fragment} > "$RUNTIME_DIRECTORY/filter-chain.conf.d/rasppi.conf"
    exec ${pkgs.pipewire}/bin/pipewire -c filter-chain.conf
  '';
in
{
  systemd.user.services.rasppi-equalizer = {
    description = "Shared ten-band equalizer for Spotify and YouTube";
    unitConfig = {
      ConditionUser = "pita";
      StartLimitIntervalSec = 0;
    };
    wants = [
      "pipewire-pulse.service"
      "wireplumber.service"
    ];
    after = [
      "pipewire.service"
      "pipewire-pulse.service"
      "wireplumber.service"
    ];
    requires = [ "pipewire.service" ];
    partOf = [ "pipewire.service" ];
    wantedBy = [ "default.target" ];
    environment.PULSE_SERVER = "unix:%t/pulse/native";
    serviceConfig = {
      ExecStart = start;
      Restart = "always";
      RestartSec = 2;
      RuntimeDirectory = "rasppi-eq";
      StateDirectory = "rasppi-control-panel";
      StateDirectoryMode = "0700";
      UMask = "0077";
    };
  };
}
