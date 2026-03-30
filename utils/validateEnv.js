/**
 * Environment Variable Validator
 * Run at server startup — exits if critical variables are missing.
 */

const REQUIRED = [
  "MONGO_URI",
  "JWT_SECRET",
  "GEMINI_API_KEY",
];

const OPTIONAL_WITH_WARNING = [
  "PORT",
  "BASE_URL",
  "RAZORPAY_KEY_ID",
  "ENCRYPTION_KEY",
  "FRONTEND_URL",
];

function validateEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);

  if (missing.length) {
    console.error("❌ FATAL: Missing required environment variables:");
    missing.forEach((k) => console.error(`   - ${k}`));
    console.error("Server cannot start. Please set these variables and restart.");
    process.exit(1);
  }

  const warnings = OPTIONAL_WITH_WARNING.filter((k) => !process.env[k]);
  if (warnings.length) {
    console.warn("⚠️  Optional env vars missing (some features may be disabled):");
    warnings.forEach((k) => console.warn(`   - ${k}`));
  }

  console.log("✅ Environment validated successfully.");
}

module.exports = validateEnv;
