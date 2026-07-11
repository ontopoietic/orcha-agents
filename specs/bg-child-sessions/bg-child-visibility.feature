# Feature: Background Task Visibility (bg-child-visibility)
# Scenarios:
#   bg-child-visibility-01: running child session appears in the parent's background task registry
#   bg-child-visibility-02: child-session task stays running after the parent turn ends instead of orphaning
#   bg-child-visibility-03: child completion moves the registry entry to a terminal status
#   bg-child-visibility-04: terminal child-session entries are cleaned up after the retention window
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
