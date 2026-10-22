const React = require('react');

const mk = (name) => (props) => React.createElement(name, props, props.children);

module.exports = {
  __esModule: true,
  default: mk('Svg'),
  Svg: mk('Svg'),
  Rect: mk('Rect'),
  Line: mk('Line'),
  Path: mk('Path'),
  Circle: mk('Circle'),
  G: mk('G'),
  Text: mk('SvgText'),
};
