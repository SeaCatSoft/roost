/* -----------------------------------------------------------------------------
   Roost — connection settings

   Fill in the two values below from your Supabase dashboard:
     Settings -> API  ->  "Project URL"  and  "anon public"

   Both are meant to be public. The anon key identifies the project, not you —
   row-level security decides what any given signed-in person can actually read.

   NEVER put the `service_role` key or the database password here. service_role
   bypasses row-level security completely, and everything in this folder is
   published to the web.
   -------------------------------------------------------------------------- */

export const SUPABASE_URL = 'https://hximaxjqeloswgyypcqi.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_lT5A64MFcXGDqesdzAydqA_cp0WwHBh';
