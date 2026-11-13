{ config, ... }:
let
  host = "rasppi.tail0fa2e4.ts.net";
  origin = "https://${host}";
in
{
  # Same static Homer/Caddy setup as HomeServer, without its Kubernetes ingress.
  services.tailscale.permitCertUid = "caddy";
  services.homer = {
    enable = true;
    virtualHost = {
      caddy.enable = true;
      domain = origin;
    };
    settings = {
      title = "RaspPi";
      subtitle = "";
      documentTitle = "RaspPi";
      icon = "fas fa-house";
      header = true;
      footer = false;
      columns = "1";
      connectivityCheck = true;
      links = [ ];
      defaults = {
        layout = "list";
        colorTheme = "dark";
      };
      services = [
        {
          name = "Services";
          items = [
            {
              name = "Audio";
              subtitle = "Volume, Spotify and YouTube";
              icon = "fas fa-volume-high";
              url = "/audio/";
            }
          ];
        }
      ];
    };
  };
  services.caddy = {
    enable = true;
    # LAN HTTP is opened only on the physical interfaces in network.nix.
    openFirewall = false;
    virtualHosts = {
      "${origin}".extraConfig = ''
        header Referrer-Policy same-origin
        # Browsers use /favicon.ico when an app declares no icon. Homer has
        # its own explicit icon URLs; serve the same host identity there too.
        @favicons path /favicon.ico /favicon.svg /apple-touch-icon.png /assets/icons/favicon.ico /assets/icons/apple-touch-icon.png
        handle @favicons {
          uri strip_prefix /assets/icons
          root * ${../assets/favicons}
          header Cache-Control "public, max-age=3600"
          file_server
        }
        redir /audio /audio/ 308
        handle_path /audio/* {
          reverse_proxy 127.0.0.1:8090 {
            flush_interval -1
          }
        }
      '';
      # Reuse Homer's generated document root and the audio proxy routes.
      "http://rasppi.local".extraConfig = config.services.caddy.virtualHosts.${origin}.extraConfig;
      "http://rasppi".extraConfig = config.services.caddy.virtualHosts.${origin}.extraConfig;
    };
  };
}
