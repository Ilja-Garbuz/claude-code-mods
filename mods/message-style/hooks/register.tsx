import type { Register } from 'claude-code'

// Your prompts in the terminal as opencode draws them, mirrored: a padded
// full-width panel with the text on the right and a blue stripe down the
// right edge. Claude's replies stay as the engine draws them; Desktop, VS
// Code and mobile keep their own look. The engine's row can't be restyled,
// so the panel is drawn here from the prompt's text; ctrl+o still shows the
// engine's row.
export const register: Register = (on, options) => {
  const panel = String(options.bubbleColor ?? '#1e1e1e')
  const stripe = String(options.stripeColor ?? '#5c9cf5')

  on('ui.render', { component: 'UserMessage', surface: 'terminal' }, async ($, e, next) => {
    // Only the person's own prompts, and the full row under ctrl+o.
    if (e.props.origin.kind !== 'composer' || e.props.isExpanded) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // The stripe is half a cell wide: a column of right-half blocks laid over
    // the last cell, clipped to the panel's height, so it never adds rows.
    return (
      <Box marginTop={1} marginLeft={2}>
        <Box flexGrow={1} flexDirection="column" alignItems="flex-end" backgroundColor={panel} paddingX={2} paddingY={1} marginRight={1}>
          <Text wrap="wrap">{e.props.text}</Text>
        </Box>
        <Box position="absolute" top={0} bottom={0} right={0} width={1} overflow="hidden">
          <Text color={stripe}>{'▐\n'.repeat(200)}</Text>
        </Box>
      </Box>
    )
  })
}
