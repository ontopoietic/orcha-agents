# Feature: Background-Subagent Routing (bg-child-routing)
# Scenarios:
#   bg-child-routing-01: background subagent attempt is intercepted and produces a child session
#   bg-child-routing-02: interception gate matrix over streaming mode, feature flag, and background parameter
#   bg-child-routing-03: rerouted spawn links the child to the parent with notify-on-complete
#   bg-child-routing-04: rerouted child inherits execution context from the parent
#   bg-child-routing-05: synchronous in-turn subagents are unaffected under streaming mode
#   bg-child-routing-06: kill switch restores upstream background behavior
#   bg-child-routing-07: the Workflow tool receives the same steering reminder as default-async subagents (p7)
#
# Env-var step convention: the value "unset" means the variable is not set.

Feature: Background-Subagent Routing
  Background subagent work in streaming mode is rerouted onto independent
  child sessions instead of in-query background tasks, so the work survives
  the end of the parent turn by construction.

  Scenario: bg-child-routing-01 background subagent attempt is intercepted and produces a child session
    Given the app runs with ORCHA_STREAMING_MODE set to "1"
    And the app runs with ORCHA_BG_CHILD_SESSIONS set to "unset"
    And a parent session is open and idle
    When the parent agent is asked to run a research task in the background
    And the parent agent attempts a subagent tool call with run_in_background set to "true"
    Then the subagent tool call is "denied"
    And the deny reason names "spawn_session" as the way to run background work
    And before the same turn ends a new child session exists in the session list
    And the parent turn ends normally

  Scenario Outline: bg-child-routing-02 interception gate matrix over streaming mode, feature flag, and background parameter
    Given the app runs with ORCHA_STREAMING_MODE set to "<streaming>"
    And the app runs with ORCHA_BG_CHILD_SESSIONS set to "<flag>"
    And a parent session is open and idle
    When the parent agent attempts a subagent tool call with run_in_background set to "<background>"
    Then the subagent tool call is "<outcome>"

    Examples:
      | streaming | flag  | background | outcome |
      | 1         | unset | true       | denied  |
      | 1         | 1     | true       | denied  |
      | 1         | 0     | true       | allowed |
      | 0         | unset | true       | allowed |
      | 0         | 1     | true       | allowed |
      | 1         | 1     | false      | allowed |

  Scenario: bg-child-routing-03 rerouted spawn links the child to the parent with notify-on-complete
    Given the app runs with ORCHA_STREAMING_MODE set to "1"
    And the app runs with ORCHA_BG_CHILD_SESSIONS set to "unset"
    And a parent session is open and idle
    When the parent agent spawns a child session for background work via spawn_session
    Then the child session records the parent session id as its parent
    And the child session is marked to notify the parent on completion

  Scenario Outline: bg-child-routing-04 rerouted child inherits execution context from the parent
    Given the app runs with ORCHA_STREAMING_MODE set to "1"
    And the app runs with ORCHA_BG_CHILD_SESSIONS set to "unset"
    And a parent session is open with model "<model>" and permission mode "<permissionMode>"
    When the parent agent spawns a child session for background work via spawn_session without overrides
    Then the child session uses model "<model>"
    And the child session uses permission mode "<permissionMode>"
    And the child session uses the parent session's working directory
    And the child session has the parent session's enabled sources

    Examples:
      | model             | permissionMode |
      | claude-sonnet-5   | allow-all      |
      | claude-haiku-4-5  | ask            |

  Scenario: bg-child-routing-05 synchronous in-turn subagents are unaffected under streaming mode
    Given the app runs with ORCHA_STREAMING_MODE set to "1"
    And the app runs with ORCHA_BG_CHILD_SESSIONS set to "unset"
    And a parent session is open and idle
    When the parent agent attempts a subagent tool call with run_in_background set to "unset"
    Then the subagent tool call is "allowed"
    And the subagent result is available inside the same parent turn
    And no new child session is created

  Scenario: bg-child-routing-06 kill switch restores upstream background behavior
    Given the app runs with ORCHA_STREAMING_MODE set to "1"
    And the app runs with ORCHA_BG_CHILD_SESSIONS set to "0"
    And a parent session is open and idle
    When the parent agent attempts a subagent tool call with run_in_background set to "true"
    Then the subagent tool call is "allowed"
    And no new child session is created

  Scenario: bg-child-routing-07 the Workflow tool receives the same steering reminder as default-async subagents (p7)
    # Field incident: an agent asked to "run this with the swarm" (plain text,
    # no [skill:...] mention) improvised with the Workflow tool instead of
    # loading the swarm skill. Workflow is background-by-design — it always
    # launches in the background and is not a PARENT_TASK_TOOLS entry, so the
    # p6 default-async reminder never covered it. This is a steering reminder,
    # not a deny: Workflow must stay usable.
    Given the app runs with ORCHA_STREAMING_MODE set to "1"
    And the app runs with ORCHA_BG_CHILD_SESSIONS set to "unset"
    And a parent session is open and idle
    When the parent agent attempts a Workflow tool call
    Then the Workflow tool call is "allowed"
    And the tool result carries a steering reminder that Workflow is background-by-design and does not survive turn end
