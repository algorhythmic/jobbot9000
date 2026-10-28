// Import only inside the configured private runtime. There is no transport or
// signing authority in this bridge; all SQL writes stay in db.ts.
import { beginPrivateExecution, finishPrivateExecution, getPrivateExecution,
  reconcilePrivateExecution, revokePrivateExecutionApproval, isExecutionApprovalRevoked } from "./db.js";
import type { ExecutionStore } from "./execution-types.js";
export const privateExecutionStore: ExecutionStore = {
  begin: beginPrivateExecution,
  finish: finishPrivateExecution,
  get: getPrivateExecution,
  reconcile: reconcilePrivateExecution,
  revoke: revokePrivateExecutionApproval,
  isRevoked: isExecutionApprovalRevoked,
};
