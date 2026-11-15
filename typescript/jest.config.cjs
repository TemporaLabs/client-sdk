/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.(t|j)sx?$': ['@swc/jest'] },
  clearMocks: true,
  roots: ['<rootDir>/tests'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/build/'],
}
