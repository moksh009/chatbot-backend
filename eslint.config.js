const globals = require("globals");
module.exports = [
    {
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.es2020
            }
        },
        rules: {
            "no-undef": "error"
        }
    }
];
