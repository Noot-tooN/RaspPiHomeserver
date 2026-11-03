{ ... }:
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
    # tailscale0 is trusted by the firewall; web access stays closed on the LAN.
    openFirewall = false;
    virtualHosts = {
      "${origin}".extraConfig = ''
        header Referrer-Policy same-origin
        redir /audio /audio/ 308
        handle_path /audio/* {
          reverse_proxy 127.0.0.1:8090 {
            flush_interval -1
          }
        }
      '';
      "http://rasppi".extraConfig = ''
        redir ${origin}{uri} 308
      '';
    };
  };
}
