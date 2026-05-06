"use strict";

const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 8 characters and include uppercase, lowercase, number, and special character.";

function validateStrongPassword(password) {
  const value = String(password || "");
  if (value.length < 8) {
    return { valid: false, message: PASSWORD_POLICY_MESSAGE };
  }

  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasNumber = /\d/.test(value);
  const hasSpecial = /[^A-Za-z0-9]/.test(value);

  if (!hasUpper || !hasLower || !hasNumber || !hasSpecial) {
    return { valid: false, message: PASSWORD_POLICY_MESSAGE };
  }

  return { valid: true, message: "" };
}

module.exports = {
  validateStrongPassword,
  PASSWORD_POLICY_MESSAGE
};
