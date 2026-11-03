{ pkgs, ... }:
let
  # Adapted from HomeServer modules/fish.nix at 7b20a1d32565, using native
  # NixOS options for pita rather than importing desktop Home Manager settings.
  preview = pkgs.writeShellScript "fzf-file-preview" ''
    if [ -d "$1" ]; then
      exec ${pkgs.eza}/bin/eza --tree --level=2 --icons --color=always -- "$1"
    else
      exec ${pkgs.bat}/bin/bat --color=always --style=numbers --line-range=:500 -- "$1"
    fi
  '';
in
{
  users.users.pita.shell = pkgs.fish;
  environment.systemPackages = with pkgs; [ bat eza fd fzf ];
  programs.fish = {
    enable = true;
    shellAbbrs = {
      ls = "eza";
      ll = "eza -la --icons --git";
      lt = "eza --tree --level=2 --icons";
      cat = "bat";
      find = "fd";
    };
    interactiveShellInit = ''
      set -g fish_greeting
      set -g fish_color_command 5fd75f
      set -g fish_color_builtin 5fd75f
      set -g fish_color_function 5fd75f
      set -g fish_color_keyword 5fd75f
      set -g fish_color_param normal
      set -g fish_color_option normal
      set -g fish_color_valid_path normal --underline
      bind ctrl-h backward-kill-word
      source ${./fish-history.fish}
      set -gx FZF_CTRL_T_COMMAND '${pkgs.fd}/bin/fd --hidden --exclude .git --type file --type directory'
      set -gx FZF_CTRL_T_OPTS "--preview '${preview} {}'"
      source ${pkgs.fzf}/share/fzf/key-bindings.fish
      fzf_key_bindings
    '';
  };
  programs.starship = {
    enable = true;
    settings = builtins.fromTOML (builtins.readFile ./starship.toml);
  };
}
