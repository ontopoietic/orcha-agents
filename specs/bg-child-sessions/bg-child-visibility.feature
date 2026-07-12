# Feature: Background Task Visibility (bg-child-visibility)
# Scenarios:
#   bg-child-visibility-01: running child session appears in the parent's background task registry
#   bg-child-visibility-02: child-session task stays running after the parent turn ends instead of orphaning
#   bg-child-visibility-03: child completion moves the registry entry to a terminal status
#   bg-child-visibility-04: terminal child-session entries are cleaned up after the retention window
#   bg-child-visibility-05: a spawn_session child created without hidden is not hidden from the session list
#   bg-child-visibility-06: a spawn_session child created with hidden:true is absent from the session list
#   bg-child-visibility-07: the "Show hidden sessions" toggle reveals hidden children in the session list
#   bg-child-visibility-08: a hidden child session is reachable via its running/finished pill and by direct navigation
#
# Env-var step convention: the value "unset" means the variable is not set.

Feature: Background Task Visibility
  Background child sessions are tracked in the parent session's background
  task registry, so the existing UI chips and the list_background_tasks tool
  report them truthfully from launch to completion.

  Background:
    Given the app runs with ORCHA_STREAMING_MODE set to "1"
    And the app runs with ORCHA_BG_CHILD_SESSIONS set to "unset"

  Scenario Outline: bg-child-visibility-01 running child session appears in the parent's background task registry
    Given a parent session is open and idle
    When the parent agent spawns a background child session named "<task>"
    Then the parent's background task list contains an entry whose task id is the child session's id
    And that entry's label is "<task>"
    And that entry's status is "running"
    And that entry's kind is "child-session"
    And a running-task chip for "<task>" is visible above the parent session's input

    Examples:
      | task                 |
      | research-competitors |
      | summarize-repo       |

  Scenario: bg-child-visibility-02 child-session task stays running after the parent turn ends instead of orphaning
    Given a parent session spawned a background child session named "survives-turn-end"
    When the parent turn that spawned the child ends
    And the child session is still processing
    Then the parent's background task entry for the child still has status "running"
    And the parent's background task list reports no "orphaned" entry for the child

  Scenario: bg-child-visibility-03 child completion moves the registry entry to a terminal status
    Given a parent session spawned a background child session named "finishes-visibly"
    When the child session's first turn ends with "success"
    Then the parent's background task entry for the child has a terminal status
    And the running-task chip for "finishes-visibly" no longer shows as running

  Scenario: bg-child-visibility-04 terminal child-session entries are cleaned up after the retention window
    Given a parent session has a terminal background task entry for a finished child session
    When more than "1" hour passes since the entry became terminal
    Then the parent's background task list no longer contains that entry

  Scenario: bg-child-visibility-05 a spawn_session child created without hidden is not hidden from the session list
    Given a parent session is open and idle
    When the parent agent spawns a child session named "standalone-delegate" without a "hidden" option
    Then the child session appears in the session list by default

  Scenario: bg-child-visibility-06 a spawn_session child created with hidden:true is absent from the session list
    Given a parent session is open and idle
    When the parent agent spawns a child session named "swarm-role-coder" with "hidden" set to "true"
    Then the child session does not appear in the session list by default
    And the child session does not appear on the kanban board by default

  Scenario: bg-child-visibility-07 the "Show hidden sessions" toggle reveals hidden children in the session list
    Given a parent session spawned a hidden child session named "swarm-role-coder"
    When the user enables the "Show hidden sessions" toggle in the session list display options
    Then the child session appears in the session list
    When the user disables the "Show hidden sessions" toggle
    Then the child session no longer appears in the session list

  Scenario: bg-child-visibility-08 a hidden child session is reachable via its running/finished pill and by direct navigation
    Given a parent session spawned a hidden child session named "swarm-role-coder"
    When the user clicks the running-task chip for "swarm-role-coder" and selects "Open session"
    Then the app navigates to the hidden child session and renders it normally
    When the child session finishes and the user clicks its finished pill
    Then the app navigates to the hidden child session and renders it normally
    When the user opens the hidden child session via a direct link to its session id
    Then the app renders the hidden child session normally
