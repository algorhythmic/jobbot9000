// Explicit private persistence bridge. Importing this module opens only the
// configured .private database. Pure people collectors do not import it.
import { collectPrivatePerson, reviewPrivatePeople, suppressPrivatePerson, deletePrivatePerson, purgeExpiredPeople } from "./db.js";
import type { PeopleStore } from "./people-types.js";
export const privatePeopleStore: PeopleStore = {
  collect: collectPrivatePerson,
  review: reviewPrivatePeople,
  suppress: suppressPrivatePerson,
  delete: deletePrivatePerson,
  purgeExpired: purgeExpiredPeople,
};
