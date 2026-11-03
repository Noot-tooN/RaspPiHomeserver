# Interactive conveniences for the previous history entry, not Bash history syntax.
function last_history_item
    test (count $history) -gt 0; or return 1
    printf '%s\n' "$history[1]"
end

function last_history_argument
    printf '%s\0' "$history[1]" | read --null --tokenize-raw --array tokens
    test (count $tokens) -gt 1; or return 1
    printf '%s\n' "$tokens[-1]"
end

function all_history_arguments
    printf '%s\0' "$history[1]" | read --null --tokenize-raw --array tokens
    test (count $tokens) -gt 1; or return 1
    string join ' ' -- $tokens[2..-1]
end

abbr --add '!!' --position anywhere --function last_history_item
abbr --add '!$' --position anywhere --function last_history_argument
abbr --add '!*' --position anywhere --function all_history_arguments
