import type { Message } from "../models";
import { merge } from "../models/read-state";
import type { State } from "./state";

export const mergeReadStates = (state: State, messages: Message[]) =>
  merge(messages, [state.messages, state.senderPane.messages(), state.openGroup].values().flatMap((source) => source));
