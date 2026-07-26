import { Type } from "@sinclair/typebox";
import {
  TASK_BATCH_MAX_TASKS,
  TASK_BATCH_MIN_TASKS,
} from "../helpers.js";

export function taskParametersSchema() {
  return Type.Object({
    agent_type: Type.String({
      description: "The type of specialist agent to use for this task",
    }),
    prompt: Type.String({
      description:
        "The complete task for the agent to perform. Be detailed and self-contained.",
    }),
    description: Type.String({
      description: "A short (3-5 word) summary of the task",
    }),
    task_id: Type.Optional(
      Type.String({
        description:
          "Resume an existing background task by id instead of starting a new task.",
      }),
    ),
    conversation_id: Type.Optional(
      Type.String({
        description:
          "Durable specialist conversation id. Reuses .pi/artifacts/task-<id>/sessions when called again.",
      }),
    ),
    fork_context: Type.Optional(
      Type.Boolean({
        description:
          "Fork the main agent's current session and pass the full conversation history to the subagent. Requires a persisted parent session.",
        default: false,
      }),
    ),
    background: Type.Optional(
      Type.Boolean({
        description:
          "Run in background (async). You will be notified when it completes. DO NOT sleep, poll, ask the task for status, or duplicate its work while it runs in background.",
        default: true,
      }),
    ),
    backend: Type.Optional(
      Type.Union(
        [
          Type.Literal("auto"),
          Type.Literal("herdr"),
          Type.Literal("tmux"),
          Type.Literal("sdk"),
        ],
        {
          description:
            "Execution backend. auto prefers Herdr inside Herdr, then tmux, then SDK.",
          default: "auto",
        },
      ),
    ),
  });
}

export function taskBatchParametersSchema() {
  return Type.Object({
    tasks: Type.Array(
      Type.Object({
        agent_type: Type.String({
          description: "The type of specialist agent to use for this task",
        }),
        prompt: Type.String({
          description:
            "The complete task for the agent to perform. Be detailed and self-contained.",
        }),
        description: Type.String({
          description: "A short (3-5 word) summary of this task",
        }),
      }),
      {
        description: `Batch items to launch. Must contain ${TASK_BATCH_MIN_TASKS}-${TASK_BATCH_MAX_TASKS} tasks.`,
        minItems: TASK_BATCH_MIN_TASKS,
        maxItems: TASK_BATCH_MAX_TASKS,
      },
    ),
    backend: Type.Optional(
      Type.Union(
        [
          Type.Literal("auto"),
          Type.Literal("herdr"),
          Type.Literal("tmux"),
          Type.Literal("sdk"),
        ],
        {
          description:
            "Execution backend. auto prefers herdr inside Herdr, then tmux, then SDK.",
          default: "auto",
        },
      ),
    ),
    tab_label: Type.Optional(
      Type.String({
        description:
          "Optional Herdr tab label for this batch. Ignored by tmux and SDK.",
      }),
    ),
    fork_context: Type.Optional(
      Type.Boolean({
        description:
          "Fork the main agent's current session for every task in this batch. Requires a persisted parent session.",
        default: false,
      }),
    ),
  });
}
