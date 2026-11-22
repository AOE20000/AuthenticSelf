/** 封装 `tools.ts` 与意图/审批模块的静态桥接，保持模块导入集中清晰。 */

import { CHANGE_RULES, INTENT_RULES, parseChange, parseIntent } from './intent'
import { APPROVER_PROMPT, buildApproverInput, parseVerdict } from './approve'

export function changePromptAndRules() {
  return { CHANGE_RULES, INTENT_RULES, parseChange, parseIntent }
}

export function approveInputText(params: Parameters<typeof buildApproverInput>[0]) {
  return {
    prompt: APPROVER_PROMPT,
    parseVerdict,
    input: buildApproverInput(params),
  }
}
