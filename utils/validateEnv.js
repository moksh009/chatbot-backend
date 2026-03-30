/**
 * Environment Variable Validator
 * Run at server startup — exits if critical variables are missing.
 */

const REQUIRED = [
  "GEMINI_API_KEY",
];

const MONGO_KEYS = ["MONGO_URI", "MONGODB_URI"];

const OPTIONAL_WITH_WARNING = [
  "PORT",
  "BASE_URL",
  "RAZORPAY_KEY_ID",
  "ENCRYPTION_KEY",
  "FRONTEND_URL",
];

function validateEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  
  // Custom check for MongoDB (allows either MONGO_URI or MONGODB_URI)
  const hasMongo = MONGO_KEYS.some(k => process.env[k]);
  if (!hasMongo) missing.push("MONGO_URI|MONGODB_URI");

  // Custom check for JWT_SECRET (provides default if missing)
  if (!process.env.JWT_SECRET) {
      if (process.env.NODE_ENV === 'production') {
          missing.push("JWT_SECRET");
      } else {
          process.env.JWT_SECRET = 'dev_secret_only';
          console.warn("⚠️  JWT_SECRET missing. Using insecure development default.");
      }
  }

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
