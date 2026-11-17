package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type unitStates map[string]map[string]string

var diagnosticUnits = []string{"spotify.service", "youtube-tv.service", "pipewire.service", "pipewire-pulse.service", "wireplumber.service", "rasppi-equalizer.service", "rasppi-audio-ready.service", "rasppi-audio-recovery.service", "rasppi-audio-recovery.timer"}

type diagnostic struct {
	Scope          string `json:"scope"`
	Code           string `json:"code"`
	Level          string `json:"level"`
	Summary        string `json:"summary"`
	Detail         string `json:"detail"`
	Recovery       string `json:"recovery"`
	RecoveryDetail string `json:"recovery_detail"`
	LastFailure    string `json:"last_failure,omitempty"`
}

type restartStatus struct {
	RequestedAt int64  `json:"requested_at"`
	Status      string `json:"status"`
	Message     string `json:"message"`
}
type restartRequest struct {
	RequestedAt        int64
	PreviousInvocation string
	Completed          bool
}

type runtimeReport struct {
	Phase       string `json:"phase"`
	Code        string `json:"code"`
	Failures    int    `json:"failures"`
	UpdatedAt   int64  `json:"updated_at"`
	Invocation  string `json:"invocation"`
	LastFailure struct {
		Code string `json:"code"`
		At   int64  `json:"at"`
	} `json:"last_failure"`
}

// Only these fixed codes can become user-facing text. No journal, command
// stderr, browser text, credentials, or arbitrary report strings reach the UI.
var reportReasons = map[string]string{
	"healthy":                         "The last health check passed.",
	"dac_initializing":                "Waiting for sound card initialization.",
	"dac_missing":                     "The DAC Pro output is missing from the audio server.",
	"backends_starting":               "Starting the shared audio services.",
	"equalizer_restarting":            "Restarting the equalizer because its playback output is missing.",
	"equalizer_starting":              "Waiting for the equalizer output to appear before retrying.",
	"players_starting":                "Starting audio readiness and the stopped players.",
	"recovery_probe_failed":           "The automatic recovery check could not read or update service state.",
	"browser_starting":                "Starting the YouTube browser.",
	"page_loading":                    "Opening the YouTube TV page.",
	"browser-command-timeout":         "The YouTube browser did not respond before its command timed out.",
	"unexpected-host":                 "The browser is not on the YouTube TV site.",
	"document-loading":                "The YouTube page has not finished loading.",
	"empty-page-without-loaded-media": "YouTube loaded an empty page with no playable media.",
	"health_checks_failed":            "YouTube failed three consecutive browser health checks.",
	"browser_endpoint_timeout":        "The YouTube browser did not open its control connection within 60 seconds.",
	"browser_exited":                  "The YouTube browser exited unexpectedly.",
	"receiver_failed":                 "The YouTube receiver stopped because of an internal error.",
}

func (c *systemController) readUnits(ctx context.Context, user bool, names ...string) unitStates {
	args := []string{}
	if user {
		args = append(args, "--user")
	}
	args = append(args, "show", "--no-pager", "--property=Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,InvocationID")
	data, err := c.run(ctx, c.systemctl, append(args, names...)...)
	result := unitStates{}
	if err != nil {
		return result
	}
	for _, block := range strings.Split(strings.TrimSpace(string(data)), "\n\n") {
		props := map[string]string{}
		for _, line := range strings.Split(block, "\n") {
			if k, v, ok := strings.Cut(line, "="); ok {
				props[k] = v
			}
		}
		result[props["Id"]] = props
	}
	return result
}

func readRuntimeReport(dir, name string, now time.Time, maxAge time.Duration) *runtimeReport {
	if dir == "" {
		return nil
	}
	file, err := os.Open(filepath.Join(dir, name, "status.json"))
	if err != nil {
		return nil
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 8192 {
		return nil
	}
	var r runtimeReport
	if json.NewDecoder(io.LimitReader(file, 8193)).Decode(&r) != nil {
		return nil
	}
	age := now.Sub(time.UnixMilli(r.UpdatedAt))
	if age < -time.Second || age > maxAge || reportReasons[r.Code] == "" || r.Failures < 0 || r.Failures > 3 {
		return nil
	}
	switch r.Phase {
	case "healthy", "waiting", "starting", "recovering", "unhealthy", "failed":
	default:
		return nil
	}
	if age := now.Sub(time.UnixMilli(r.LastFailure.At)); age < 0 || age > 24*time.Hour {
		r.LastFailure.Code = ""
	}
	return &r
}

func unitFailure(unit map[string]string) string {
	switch unit["Result"] {
	case "exit-code":
		if n, err := strconv.Atoi(unit["ExecMainStatus"]); err == nil && n > 0 && n < 256 {
			return fmt.Sprintf("The process exited with code %d.", n)
		}
		return "The process exited with an error."
	case "signal", "core-dump":
		return "The process was terminated by a signal."
	case "timeout":
		return "The service exceeded its start or stop timeout."
	case "oom-kill":
		return "The system stopped the process because it ran out of memory."
	case "start-limit-hit":
		return "Too many starts failed; the service manager stopped retrying."
	case "resources":
		return "The service manager could not allocate the resources needed to start."
	default:
		return "The service is not running."
	}
}

func issue(scope, code, summary, detail string) *diagnostic {
	return &diagnostic{Scope: scope, Code: code, Level: "warning", Summary: summary, Detail: detail}
}

func sharedAudioIssue(audio audioState, units, system unitStates) *diagnostic {
	mixer := system["rasppi-dac-mixer.service"]
	if mixer["ActiveState"] == "failed" {
		return issue("audio", "dac_setup_failed", "Sound card setup failed", unitFailure(mixer))
	}
	if mixer["ActiveState"] == "activating" {
		return issue("audio", "dac_initializing", "Sound card is initializing", "Both players are waiting for the DAC mixer setup to finish.")
	}
	for _, dep := range []struct{ unit, name string }{
		{"pipewire.service", "Audio server"}, {"pipewire-pulse.service", "Audio connection"},
		{"wireplumber.service", "Audio routing"}, {"rasppi-equalizer.service", "Equalizer"},
	} {
		unit := units[dep.unit]
		if unit["ActiveState"] == "" {
			return issue("audio", "audio_status_unknown", "Audio status could not be read", "The dashboard cannot confirm the shared audio dependencies.")
		}
		if unit["ActiveState"] != "active" {
			return issue("audio", "dependency_"+strings.TrimSuffix(dep.unit, ".service"), dep.name+" is not ready", unitFailure(unit))
		}
	}
	if !audio.sinksKnown {
		return issue("audio", "audio_probe_failed", "Cannot read audio outputs", "The audio server did not return a usable list of playback outputs.")
	}
	if !audio.dacPresent {
		return issue("audio", "dac_missing", "DAC Pro output is missing", "The physical sound output is not registered with the audio server.")
	}
	if !audio.equalizerPresent {
		return issue("audio", "equalizer_missing", "Equalizer output is missing", "The equalizer process is running, but it has no playback output. Both players depend on that output.")
	}
	ready := units["rasppi-audio-ready.service"]
	if ready["ActiveState"] != "active" {
		return issue("audio", "audio_not_ready", "Audio readiness has not completed", "The players cannot start until the shared audio readiness check succeeds. "+unitFailure(ready))
	}
	return nil
}

func recoveryFor(d *diagnostic, units unitStates, report *runtimeReport) {
	timer, worker := units["rasppi-audio-recovery.timer"], units["rasppi-audio-recovery.service"]
	d.Recovery, d.RecoveryDetail = "unknown", "Automatic recovery status could not be read."
	if timer["ActiveState"] != "" {
		if timer["ActiveState"] != "active" {
			d.Recovery, d.RecoveryDetail = "disabled", "Automatic audio recovery is off. Restart the service in Settings, or enable the recovery timer."
			return
		}
		d.Recovery, d.RecoveryDetail = "scheduled", "Automatic recovery is enabled; waiting for the next check."
	}
	if worker["ActiveState"] == "activating" || worker["ActiveState"] == "active" {
		d.Recovery, d.RecoveryDetail = "recovering", "An automatic recovery check is running."
	}
	if report != nil {
		switch report.Phase {
		case "recovering", "waiting":
			d.Recovery, d.RecoveryDetail = report.Phase, reportReasons[report.Code]
		case "failed":
			d.RecoveryDetail = reportReasons[report.Code] + " The timer will retry."
		}
	}
}

func (c *systemController) diagnose(s *state, units, system unitStates) {
	now := time.Now()
	shared := sharedAudioIssue(s.Audio, units, system)
	recovery := readRuntimeReport(c.runtimeDir, "rasppi-audio-recovery", now, 45*time.Second)
	receiver := readRuntimeReport(c.runtimeDir, "rasppi-youtube", now, 100*time.Second)
	if shared != nil {
		recoveryFor(shared, units, recovery)
	}
	for i := range s.Services {
		service := &s.Services[i]
		var player playerState
		for _, p := range s.Players {
			if p.ID == service.ID {
				player = p
			}
		}
		unitName, _ := serviceUnit(service.ID)
		unit := units[unitName]
		d := shared
		if d == nil && service.Error != "" {
			d = issue(service.ID, "status_unknown", service.Name+" status is unknown", service.Error)
		}
		if d == nil && service.Active != "active" {
			d = issue(service.ID, "service_"+service.Active, service.Name+" service is "+service.Active, unitFailure(unit))
			recoveryFor(d, units, recovery)
			if service.Active == "activating" || service.Active == "deactivating" {
				d.Recovery, d.RecoveryDetail = "recovering", "The service manager is restarting "+service.Name+"."
				if service.Sub == "auto-restart" {
					d.Recovery, d.RecoveryDetail = "scheduled", "The service manager has scheduled another start."
				}
			}
		}
		if d == nil && !player.Available {
			d = issue(service.ID, "control_unavailable", service.Name+" controls are not responding", "The process is running, but the dashboard cannot read the player state.")
			d.Recovery, d.RecoveryDetail = "unknown", "No restart is currently confirmed. You can request one in Settings."
			if player.ErrorCode == "control_timeout" {
				d.Code, d.Detail = "control_timeout", "The player control request timed out; the service is still running."
			}
			if service.ID == "youtube" && receiver != nil && receiver.Invocation == unit["InvocationID"] {
				d.Recovery, d.RecoveryDetail = "monitoring", "The browser health monitor is active. No restart is currently in progress."
				switch receiver.Phase {
				case "starting":
					d.Code, d.Summary, d.Detail, d.Recovery = receiver.Code, "YouTube is starting", reportReasons[receiver.Code], "recovering"
					d.RecoveryDetail = "Waiting for the browser and player controls to become ready."
				case "unhealthy", "failed":
					d.Code, d.Summary, d.Detail = receiver.Code, "YouTube browser check failed", reportReasons[receiver.Code]
					d.RecoveryDetail = fmt.Sprintf("%d of 3 consecutive checks failed. The receiver restarts after the third failed check.", receiver.Failures)
					if receiver.Phase == "failed" {
						d.Recovery, d.RecoveryDetail = "scheduled", "The receiver exited; the service manager will retry."
					}
				}
				if message := reportReasons[receiver.LastFailure.Code]; message != "" {
					d.LastFailure = message
				}
			}
		}
		if d != nil && d.Scope == service.ID && (d.Code == "control_unavailable" || d.Code == "control_timeout") && c.restartWarming(service.ID, unit["InvocationID"], now) {
			d.Code, d.Summary = "player_starting", service.Name+" is starting"
			d.Detail = "The restarted process is running, but its controls are not ready yet."
			d.Recovery, d.RecoveryDetail = "recovering", "Waiting for the new player session to respond."
		}
		if d != nil && d.Recovery == "" {
			recoveryFor(d, units, recovery)
		}
		if d != nil && d.Scope == "youtube" && receiver != nil {
			d.LastFailure = reportReasons[receiver.LastFailure.Code]
		}
		service.Diagnostic = d
		service.Restart = c.restartOutcome(service.ID, unit["InvocationID"], service.Active == "active" && player.Available && shared == nil, d, now)
	}
}

func (c *systemController) restartOutcome(id, invocation string, healthy bool, d *diagnostic, now time.Time) *restartStatus {
	c.restartMu.Lock()
	defer c.restartMu.Unlock()
	request := c.restarts[id]
	if request == nil || now.UnixMilli()-request.RequestedAt > 10*60*1000 {
		return nil
	}
	if healthy && invocation != "" && invocation != request.PreviousInvocation {
		request.Completed = true
	}
	result := &restartStatus{RequestedAt: request.RequestedAt, Status: "pending", Message: "Restart requested. Waiting for a new player session to respond."}
	if request.Completed {
		result.Status, result.Message = "completed", "Restart completed; the player is responding."
	} else if d != nil && d.Recovery != "recovering" {
		result.Status, result.Message = "blocked", "Restart has not completed. "+d.Summary+". "+d.RecoveryDetail
	} else if now.UnixMilli()-request.RequestedAt > 120000 {
		result.Status, result.Message = "timed_out", "Restart has not completed after two minutes. Check the current service details."
	}
	return result
}

// A new process can take time to open its API. Treat that bounded warm-up as
// progress, while real dependency failures remain blocked immediately.
func (c *systemController) restartWarming(id, invocation string, now time.Time) bool {
	c.restartMu.Lock()
	defer c.restartMu.Unlock()
	request := c.restarts[id]
	return request != nil && !request.Completed && invocation != "" && invocation != request.PreviousInvocation && now.UnixMilli()-request.RequestedAt < 120000
}
