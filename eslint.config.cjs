const { FlatCompat } = require('@eslint/eslintrc');
const compat = new FlatCompat({ baseDirectory: __dirname });

module.exports = [
  // Load existing .eslintrc.json via compat
  ...compat.extends('./.eslintrc.json')
];
