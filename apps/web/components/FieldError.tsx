/** The error for one input, right under it. Renders nothing when there is none. */
export default function FieldError({ message, name }: { message?: string; name?: string }) {
  if (!message) return null;
  return (
    <p role="alert" data-field-error={name} className="mt-1 text-xs font-medium text-red-600">
      {message}
    </p>
  );
}
