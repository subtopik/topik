/**
 * Whether text holds a C0 control character or DEL. `allowTab` admits tabs, and `includeSpace`
 * also refuses the space character.
 */
export function hasControlCharacters(
  value: string,
  allowTab = false,
  includeSpace = false,
): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if ((unit < (includeSpace ? 33 : 32) && !(allowTab && unit === 9)) || unit === 127) return true;
  }
  return false;
}
