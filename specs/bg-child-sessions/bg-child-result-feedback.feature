# Feature: Background Result Feedback (bg-child-result)
# Scenarios:
#   bg-child-result-01: completed or failed child delivers exactly one structured result message to the parent
#   bg-child-result-02: result to an idle parent is delivered and starts a parent turn immediately
#   bg-child-result-03: result to a busy parent is queued and processed after the current turn
#   bg-child-result-04: follow-up turns in the child session do not notify the parent again
#   bg-child-result-05: oversized child result is truncated with a reference to the child session
#   bg-child-result-06: delivered result is observed into the parent's observation ledger
#
# Env-var step convention: the value "unset" means the variable is not set.

Feature: Background Result Feedback
  A finished background child session sends its result back to the parent
  session as a normal cross-session message, so the parent processes it as
  an ordinary turn and the observation memory records it.

  Background:
    Given the app runs with ORCHA_STREAMING_MODE set to "1"
    And the app runs with ORCHA_BG_CHILD_SESSIONS set to "unset"

  Scenario Outline: bg-child-result-01 completed or failed child delivers exactly one structured result message to the parent
    Given a parent session spawned a background child session named "<task>"
    When the child session's first turn ends with "<childOutcome>"
    Then the parent session receives exactly one background_result message for "<task>"
    And the background_result block's childSessionId attribute is the child session's id
    And the background_result block's status attribute is "<status>"
    And the background_result block's body contains the child's "<bodyContent>"

    Examples:
      | task                 | childOutcome | status    | bodyContent          |
      | research-competitors | success      | completed | final assistant text |
      | broken-api-fetch     | an error     | failed    | last error text      |

  Scenario: bg-child-result-02 result to an idle parent is delivered and starts a parent turn immediately
    Given a parent session spawned a background child session named "idle-delivery-check"
    And the parent session is idle
    When the child session's first turn ends with "success"
    Then the result message delivery is acknowledged as "delivered"
    And the parent session starts processing the result message without user action

  Scenario: bg-child-result-03 result to a busy parent is queued and processed after the current turn
    Given a parent session spawned a background child session named "busy-delivery-check"
    And the parent session is processing another turn
    When the child session's first turn ends with "success"
    Then the result message delivery is acknowledged as "queued"
    And the parent session processes the result message after its current turn ends
    And the parent session's current turn is not interrupted

  Scenario: bg-child-result-04 follow-up turns in the child session do not notify the parent again
    Given a parent session spawned a background child session named "one-shot-check"
    When the child session's first turn ends with "success"
    And a user sends a follow-up message in the child session
    And the child session's follow-up turn ends with "success"
    Then the parent session receives exactly one background_result message for "one-shot-check"

  Scenario: bg-child-result-05 oversized child result is truncated with a reference to the child session
    Given a parent session spawned a background child session named "oversized-result-check"
    And the child session's final assistant text is larger than the result size cap of "16" kilobytes
    When the child session's first turn ends with "success"
    Then the background_result block's body is at most "16" kilobytes
    And the background_result block's body names the child session as the place to read the full result

  Scenario: bg-child-result-06 delivered result is observed into the parent's observation ledger
    Given a parent session spawned a background child session named "observation-check"
    When the child session's first turn ends with "success"
    And the parent session finishes processing the result message
    Then the parent session's observation ledger contains an observation about the "observation-check" result
