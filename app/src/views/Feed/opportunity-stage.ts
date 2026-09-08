/** A browsing preference, not an employer eligibility verdict. */
export function matchesGraduationStage(
  posting: { title: string; term: string | null },
  graduation: string | undefined,
  today = new Date(),
): boolean {
  if (!graduation || !/^\d{4}-(0[1-9]|1[0-2])$/.test(graduation)) return true;
  const graduationYear = Number(graduation.slice(0, 4));
  if (graduationYear <= today.getFullYear() + 1) return true;

  // Term classification also labels some student programs as new_grad. Preserve
  // explicit internships/co-ops, even when their description mentions graduates.
  if (/\b(?:intern(?:ship)?s?|co[ -]?op|cooperative education)\b/i.test(posting.title)) return true;
  if (/\b(?:new[ -]+grad(?:uate)?s?|recent[ -]+grad(?:uate)?s?|university[ -]+grad(?:uate)?s?|entry[ -]+level)\b/i.test(posting.title)) return false;
  if (/\b(?:summer|fall|winter|spring)\s+(?:analyst|associate)\b/i.test(posting.title)) return true;
  return posting.term !== 'new_grad';
}
