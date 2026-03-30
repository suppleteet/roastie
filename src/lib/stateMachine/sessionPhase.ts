import type { TransitionMap } from "./types";

export type SessionPhase =
  | "idle"
  | "consent"
  | "requesting-permissions"
  | "roasting"
  | "stopped"
  | "sharing";

export type SessionTrigger =
  | "START_CLICKED"
  | "CONSENT_ACCEPTED"
  | "CONSENT_BACK"
  | "PERMISSIONS_GRANTED"
  | "PERMISSIONS_DENIED"
  | "STOP_CLICKED"
  | "SESSION_RESTART"
  | "SHARE_CLICKED"
  | "SHARE_DISMISSED"
  | "RESET"
  | "DEBUG_TOGGLE"
  | "ERROR";

export const SESSION_TRANSITIONS: TransitionMap<SessionPhase> = {
  "idle":                   ["consent", "requesting-permissions"],
  "consent":                ["requesting-permissions", "idle"],
  "requesting-permissions": ["roasting", "idle"],
  "roasting":               ["stopped", "idle"],
  "stopped":                ["roasting", "requesting-permissions", "sharing", "idle"],
  "sharing":                ["idle"],
};
