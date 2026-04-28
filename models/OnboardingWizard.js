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
 * Step IDs (must match STEPS array in OnboardingWizard.jsx):
 *   0: business    | 1: whatsapp   | 2: products   | 3: store
 *   4: operations  | 5: cart_timing | 6: payment   | 7: ai
 *   8: meta_ads    | 9: instagram  | 10: templates | 11: architecture
 */

const STEP_IDS = [
  "business", "whatsapp", "products", "store",
  "operations", "cart_timing", "payment", "ai",
  "meta_ads", "instagram", "templates", "architecture"
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
      max: 11,
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
      whatsapp:     { type: mongoose.Schema.Types.Mixed, default: null },
      products:     { type: mongoose.Schema.Types.Mixed, default: null },
      store:        { type: mongoose.Schema.Types.Mixed, default: null },
      operations:   { type: mongoose.Schema.Types.Mixed, default: null },
      cart_timing:  { type: mongoose.Schema.Types.Mixed, default: null },
      payment:      { type: mongoose.Schema.Types.Mixed, default: null },
      ai:           { type: mongoose.Schema.Types.Mixed, default: null },
      meta_ads:     { type: mongoose.Schema.Types.Mixed, default: null },
      instagram:    { type: mongoose.Schema.Types.Mixed, default: null },
      templates:    { type: mongoose.Schema.Types.Mixed, default: null },
      architecture: { type: mongoose.Schema.Types.Mixed, default: null },
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
