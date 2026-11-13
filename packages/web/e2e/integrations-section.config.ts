import original from './extensions.config'

export default {
  ...original,
  tests: './integrations-section.e2e.ts',
  output: '.e2e/integrations-mobile',
}
