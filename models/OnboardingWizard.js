"use strict";

const mongoose = require("mongoose");

/**
 * OnboardingWizard — Persistent step-by-step wizard state.
 *
 * Step IDs — MUST match STEPS array in OnboardingWizard.jsx (7 steps, schema v3):
 *   0: business | 1: connections | 2: features | 3: products | 4: escalation
 *   5: ai | 6: architecture
 *
 * `cart_timing` remains as optional legacy bucket; cart ladder lives in features step UI.
 */

const STEP_IDS = [
  "business",
  "connections",
  "features",
  "products",
  "escalation",
  "ai",
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

    wizardSchemaVersion: {
      type: Number,
      default: 3,
      min: 1,
      max: 10,
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

    stepData: {
      business:     { type: mongoose.Schema.Types.Mixed, default: null },
      connections:  { type: mongoose.Schema.Types.Mixed, default: null },
      features:     { type: mongoose.Schema.Types.Mixed, default: null },
      products:     { type: mongoose.Schema.Types.Mixed, default: null },
      escalation:   { type: mongoose.Schema.Types.Mixed, default: null },
      ai:           { type: mongoose.Schema.Types.Mixed, default: null },
      architecture: { type: mongoose.Schema.Types.Mixed, default: null },
      cart_timing:  { type: mongoose.Schema.Types.Mixed, default: null },
      whatsapp:     { type: mongoose.Schema.Types.Mixed, default: null },
      store:        { type: mongoose.Schema.Types.Mixed, default: null },
      operations:   { type: mongoose.Schema.Types.Mixed, default: null },
      payment:      { type: mongoose.Schema.Types.Mixed, default: null },
      meta_ads:     { type: mongoose.Schema.Types.Mixed, default: null },
      instagram:    { type: mongoose.Schema.Types.Mixed, default: null },
      templates:    { type: mongoose.Schema.Types.Mixed, default: null },
    },

    deploymentResult: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

OnboardingWizardSchema.statics.STEP_IDS = STEP_IDS;

module.exports = mongoose.model("OnboardingWizard", OnboardingWizardSchema);
