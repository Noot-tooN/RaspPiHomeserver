{ ... }:
{
  services.comin = {
    enable = true;
    hostname = "rasppi";
    remotes = [
      {
        name = "origin";
        url = "https://github.com/Noot-tooN/RaspPiHomeserver.git";
        branches.main.name = "master";
      }
    ];
  };
}
