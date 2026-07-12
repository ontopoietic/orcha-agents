# Feature: Keep-Alive Resolution (bg-child-keepalive)
# Scenarios:
#   bg-child-keepalive-01: query lifecycle matrix over streaming mode and keep-alive variable
#   bg-child-keepalive-02: observation replacement reduces parent context across turns under streaming mode
#   bg-child-keepalive-03: end-to-end background work with shrinking context and observed result
#   bg-child-keepalive-04: upstream keep-alive regression guard with streaming mode off
#   bg-child-keepalive-05: honest orphaning of a default-async in-query subagent under streaming (p6 incident)
#   bg-child-keepalive-06: Stop hook blocks turn-end once while in-query background tasks are still running (p7 incident)
#   bg-child-keepalive-07: Stop hook never blocks outside its gate (streaming off, flag off, no running tasks)
#
# Env-var step convention: the value "unset" means the variable is not set.

Feature: Keep-Alive Resolution
  With background work rerouted onto child sessions, streaming mode no longer
  needs the persistent keep-alive query. Streaming mode wins: each turn runs a
  fresh query so the observation memory replaces history every turn. With
  streaming mode off, upstream keep-alive behavior is unchanged.

  Scenario Outline: bg-child-keepalive-01 query lifecycle matrix over streaming mode and keep-alive variable
    Given the app runs with ORCHA_STREAMING_MODE set to "<streaming>"
    And the app runs with CRAFT_KEEP_BG_AGENTS_ALIVE set to "<keepAlive>"
    And a session is open and idle
    When the session completes a turn
    Then the session's agent query is "<lifecycle>"

    Examples:
      | streaming | keepAlive | lifecycle                  |
      | 1         | unset     | torn down after the turn   |
      | 1         | 1         | torn down after the turn   |
      | 0         | unset     | kept alive across turns    |
      | 0         | 1         | kept alive across turns    |
      | 0         | 0         | torn down after the turn   |

  Scenario: bg-child-keepalive-02 observation replacement reduces parent context across turns under streaming mode
    Given the app runs with ORCHA_STREAMING_MODE set to "1"
    And a session is open with enough history that observations exist
    When the user sends "3" further messages that each complete a turn
    Then the session's context usage percentage after the last turn is lower than a linearly growing history would produce
    And each of those turns was served by a fresh agent query

  Scenario: bg-child-keepalive-03 end-to-end background work with shrinking context and observed result
    Given the app runs with ORCHA_STREAMING_MODE set to "1"
    And the app runs with ORCHA_BG_CHILD_SESSIONS set to "unset"
    And a parent session is open and idle
    When the user asks the parent agent to run a long task named "e2e-background-run" in the background
    Then a child session for "e2e-background-run" is running while the parent turn ends normally
    When the user sends "2" further messages in the parent session
    Then the parent session's context usage percentage does not grow monotonically with raw history
    When the child session's first turn ends with "success"
    Then the parent session receives exactly one background_result message for "e2e-background-run"
    And the parent session's observation ledger contains an observation about the "e2e-background-run" result

  Scenario: bg-child-keepalive-04 upstream keep-alive regression guard with streaming mode off
    Given the app runs with ORCHA_STREAMING_MODE set to "0"
    And the app runs with CRAFT_KEEP_BG_AGENTS_ALIVE set to "unset"
    And a session is open and idle
    When the session's agent launches an in-query background subagent
    And the turn that launched it ends
    Then the background subagent keeps running after the turn ends
    And the session's background task list reports it as "running"
    And no child session is created for it

  Scenario: bg-child-keepalive-05 honest orphaning of a default-async in-query subagent under streaming
    Given the app runs with ORCHA_STREAMING_MODE set to "1"
    And the app runs with CRAFT_KEEP_BG_AGENTS_ALIVE set to "1"
    And a session is open and idle
    When the session's agent launches an Agent tool call without run_in_background
    And the turn that launched it ends before the subagent reports back
    Then the session's background task list reports the still-running entry as "orphaned", not "running"
    And a child-session-kind entry for the same session is left "running", unaffected by the sweep
    # Regression guard: this is the production incident. Before the fix,
    # SessionManager's keepBackgroundTasksAlive read the raw
    # CRAFT_KEEP_BG_AGENTS_ALIVE flag (still true) without folding in
    # streaming mode, so markOrphanedBackgroundTasks early-returned and the
    # entry stayed "running" for 3+ hours — a zombie neither TaskOutput nor
    # TaskStop could resolve.

  Scenario: bg-child-keepalive-06 Stop hook blocks turn-end once while in-query background tasks are still running
    # Field incident: an agent improvised orchestration via the Workflow tool
    # (a third spawn path the Step-0 gate doesn't cover) and ended its turn
    # ~10s later; the in-query task died at teardown with zero indicator.
    # The Stop hook is the structural catch-all for every such path, not just
    # Agent/Task/Workflow specifically.
    Given the app runs with ORCHA_STREAMING_MODE set to "1"
    And the app runs with ORCHA_BG_CHILD_SESSIONS set to "unset"
    And a session is open and idle
    And the session's agent has an in-query background task still running
    When the model attempts to end its turn
    Then the Stop hook blocks the turn-end with a reason naming the running task count
    And the reason mentions "TaskOutput", "TaskStop", and "spawn_session" as ways to resolve it
    When the model attempts to end its turn a second time in the same turn
    Then the Stop hook does not block again, even though the task is still running

  Scenario: bg-child-keepalive-07 Stop hook never blocks outside its gate
    Given a session is open and idle
    And the session's agent has an in-query background task still running
    When the model attempts to end its turn with ORCHA_STREAMING_MODE set to "0"
    Then the Stop hook does not block
    When the model attempts to end its turn with ORCHA_BG_CHILD_SESSIONS set to "0"
    Then the Stop hook does not block
    When the model attempts to end its turn with no running background tasks
    Then the Stop hook does not block
