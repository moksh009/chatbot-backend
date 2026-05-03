"use strict";

const mongoose = require("mongoose");

/**
 * OnboardingWizard — Persistent step-by-step wizard state.
 *
 * Architecture:
 *   One document per clientId. Each wizard step writes to its own sub-key
 *   inside `stepData`. This survives browser refreshes, device switches,
 *   and server restarts — replacing the previous localStorage-only approach.
 *
 * Step IDs — MUST match STEPS array order in OnboardingWizard.jsx (7 steps):
 *   0: business | 1: connections | 2: products | 3: ai
 *   4: cart_timing | 5: features | 6: architecture
 *
 * Legacy keys (whatsapp, store, operations, payment, …) remain on stepData for
 * older documents; PATCH may copy legacy → canonical buckets when needed.
 */

const STEP_IDS = [
  "business",
  "connections",
  "products",
  "ai",
  "cart_timing",
  "features",
  "architecture",
];

const OnboardingWizardSchema = new mongoose.Schema(
  {
    clientId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    currentStep: {
      type: Number,
      default: 0,
      min: 0,
      max: 6,
    },

    completedSteps: {
      type: [Number],
      default: [],
    },

    status: {
      type: String,
      enum: ["in_progress", "completed", "abandoned"],
      default: "in_progress",
    },

    // Step data — each step writes to its own sub-document.
    // Using Mixed types to avoid schema churn as wizard fields evolve.
    stepData: {
      business:     { type: mongoose.Schema.Types.Mixed, default: null },
      connections:  { type: mongoose.Schema.Types.Mixed, default: null },
      products:     { type: mongoose.Schema.Types.Mixed, default: null },
      ai:           { type: mongoose.Schema.Types.Mixed, default: null },
      cart_timing:  { type: mongoose.Schema.Types.Mixed, default: null },
      features:     { type: mongoose.Schema.Types.Mixed, default: null },
      architecture: { type: mongoose.Schema.Types.Mixed, default: null },
      // Legacy buckets (pre–step-order fix)
      whatsapp:     { type: mongoose.Schema.Types.Mixed, default: null },
      store:        { type: mongoose.Schema.Types.Mixed, default: null },
      operations:   { type: mongoose.Schema.Types.Mixed, default: null },
      payment:      { type: mongoose.Schema.Types.Mixed, default: null },
      meta_ads:     { type: mongoose.Schema.Types.Mixed, default: null },
      instagram:    { type: mongoose.Schema.Types.Mixed, default: null },
      templates:    { type: mongoose.Schema.Types.Mixed, default: null },
    },

    // Post-launch deployment stats
    deploymentResult: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true, // createdAt + updatedAt
  }
);

// Expose STEP_IDS for route-level validation
OnboardingWizardSchema.statics.STEP_IDS = STEP_IDS;

module.exports = mongoose.model("OnboardingWizard", OnboardingWizardSchema);
