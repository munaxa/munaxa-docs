/**
 * The machinery every administration area is built from.
 *
 * This is `features/shared` in the sense the features README describes: a piece moves here on its
 * *third* consumer, and every export below has between four and eighteen. The list component, the
 * form dialogue and the field set are the three genuinely repeated shapes in Administration; the
 * screens themselves are not, and none of them lives here.
 */
export { AdminForbidden, AdminScreen, Prerequisite } from './screen';
export { ResourceList, StateBadges, type RowAction } from './resource-list';
export { FormDialog } from './form-dialog';
export { useAdminColumns } from './columns';
export { changedFields, isEmptyPatch, unchanged } from './patch';
export { useListNavigation, type ListNavigation } from './list-url';
export { useAction } from './use-action';
export {
  CheckboxGroupField,
  MultiPickerField,
  NumberField,
  PickerField,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField,
  type Choice,
  flag,
  integer,
  list,
  nullableText,
  optionalText,
  text,
} from './fields';
