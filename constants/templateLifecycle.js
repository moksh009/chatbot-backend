"use strict";

const PREBUILT_REQUIRED_TEMPLATES = [
  "order_confirmed",
  "cart_recovery_1",
  "cart_recovery_2",
  "admin_human_alert",
  "review_request"
];

const TEMPLATE_STATUS = {
  DRAFT: "draft",
  QUEUED: "queued",
  SUBMITTING: "submitting",
  PENDING_REVIEW: "pending_meta_review",
  APPROVED: "approved",
  REJECTED: "rejected",
  FLAGGED: "flagged",
  SUBMISSION_FAILED: "submission_failed",
  GENERATION_FAILED: "generation_failed"
};

const NORMALIZED_LIFECYCLE_STATUS = {
  DRAFT: "DRAFT",
  QUEUED: "QUEUED",
  SUBMITTING: "SUBMITTING",
  PENDING_REVIEW: "PENDING_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  FAILED: "FAILED"
};

function normalizeTemplateStatus(rawStatus) {
  const status = String(rawStatus || "").toLowerCase();
  if (status === TEMPLATE_STATUS.APPROVED || status === "approved") return NORMALIZED_LIFECYCLE_STATUS.APPROVED;
  if (status === TEMPLATE_STATUS.REJECTED || status === "rejected") return NORMALIZED_LIFECYCLE_STATUS.REJECTED;
  if (status === TEMPLATE_STATUS.FLAGGED || status === "flagged") return NORMALIZED_LIFECYCLE_STATUS.PENDING_REVIEW;
  if (status === TEMPLATE_STATUS.PENDING_REVIEW || status === "pending" || status === "in_appeal") return NORMALIZED_LIFECYCLE_STATUS.PENDING_REVIEW;
  if (status === TEMPLATE_STATUS.SUBMITTING) return NORMALIZED_LIFECYCLE_STATUS.SUBMITTING;
  if (status === TEMPLATE_STATUS.QUEUED) return NORMALIZED_LIFECYCLE_STATUS.QUEUED;
  if (status === TEMPLATE_STATUS.SUBMISSION_FAILED || status === TEMPLATE_STATUS.GENERATION_FAILED || status === "failed") {
    return NORMALIZED_LIFECYCLE_STATUS.FAILED;
  }
  return NORMALIZED_LIFECYCLE_STATUS.DRAFT;
}

module.exports = {
  PREBUILT_REQUIRED_TEMPLATES,
  TEMPLATE_STATUS,
  NORMALIZED_LIFECYCLE_STATUS,
  normalizeTemplateStatus
};
