import { sql, type Kysely } from 'kysely';

/**
 * Migration 0055 (BACKLOG T901; QA S7 H1, L9; CONTRACTS §1.1, §13, §21):
 * stored time zones become their IANA primary name (`Asia/Saigon` →
 * `Asia/Ho_Chi_Minh`, `US/Eastern` → `America/New_York`), the name
 * `postgres:18` (no tzdata `backward`) knows. Values stored before T819
 * kept the name the browser or the API caller sent.
 *
 * Rewritten: `meta.users.timezone`, `timezone` of `meta.organizations.settings`
 * and `meta.bases.settings`, `options.timezone` of `meta.fields` (date
 * fields), `trigger.timezone` of `meta.automations.definition` (`schedule`),
 * deleted rows included. Names match case-insensitively. A name the map
 * does not know stays as it is; only the count of those values goes to the
 * PostgreSQL log (`WARNING`), never a value. Cell values do not change
 * (an alias is the same zone), so nothing is recomputed. Running the
 * statement again changes no row.
 *
 * The map is data, not `Intl`, so the result does not depend on the ICU
 * of the process that runs it: every zone name `canonicalTimeZone`
 * (`@cellhive/contracts`) accepted on 2026-10-31 (Node 24.22.1, ICU 78.3,
 * tzdata 2026e) — the zone and link names of tzdata, `Intl.supportedValuesOf`
 * and the ICU zone ids — to `canonicalTimeZone(name)`: 462 names that are
 * already canonical, 175 aliases.
 *
 * Self-contained (only `meta.*` tables of 0001/0003/0027), so its number
 * can change at merge. This file is locked by `migrations.lock.json`: never
 * edit it once merged.
 */

/** Names `canonicalTimeZone` returns unchanged. */
const CANONICAL_NAMES = `
  Africa/Abidjan Africa/Accra Africa/Addis_Ababa Africa/Algiers Africa/Asmara Africa/Bamako
  Africa/Bangui Africa/Banjul Africa/Bissau Africa/Blantyre Africa/Brazzaville Africa/Bujumbura
  Africa/Cairo Africa/Casablanca Africa/Ceuta Africa/Conakry Africa/Dakar Africa/Dar_es_Salaam
  Africa/Djibouti Africa/Douala Africa/El_Aaiun Africa/Freetown Africa/Gaborone Africa/Harare
  Africa/Johannesburg Africa/Juba Africa/Kampala Africa/Khartoum Africa/Kigali Africa/Kinshasa
  Africa/Lagos Africa/Libreville Africa/Lome Africa/Luanda Africa/Lubumbashi Africa/Lusaka
  Africa/Malabo Africa/Maputo Africa/Maseru Africa/Mbabane Africa/Mogadishu Africa/Monrovia
  Africa/Nairobi Africa/Ndjamena Africa/Niamey Africa/Nouakchott Africa/Ouagadougou
  Africa/Porto-Novo Africa/Sao_Tome Africa/Tripoli Africa/Tunis Africa/Windhoek America/Adak
  America/Anchorage America/Anguilla America/Antigua America/Araguaina
  America/Argentina/Buenos_Aires America/Argentina/Catamarca America/Argentina/Cordoba
  America/Argentina/Jujuy America/Argentina/La_Rioja America/Argentina/Mendoza
  America/Argentina/Rio_Gallegos America/Argentina/Salta America/Argentina/San_Juan
  America/Argentina/San_Luis America/Argentina/Tucuman America/Argentina/Ushuaia America/Aruba
  America/Asuncion America/Bahia America/Bahia_Banderas America/Barbados America/Belem
  America/Belize America/Blanc-Sablon America/Boa_Vista America/Bogota America/Boise
  America/Cambridge_Bay America/Campo_Grande America/Cancun America/Caracas America/Cayenne
  America/Cayman America/Chicago America/Chihuahua America/Ciudad_Juarez America/Coral_Harbour
  America/Costa_Rica America/Coyhaique America/Creston America/Cuiaba America/Curacao
  America/Danmarkshavn America/Dawson America/Dawson_Creek America/Denver America/Detroit
  America/Dominica America/Edmonton America/Eirunepe America/El_Salvador America/Fort_Nelson
  America/Fortaleza America/Glace_Bay America/Goose_Bay America/Grand_Turk America/Grenada
  America/Guadeloupe America/Guatemala America/Guayaquil America/Guyana America/Halifax
  America/Havana America/Hermosillo America/Indiana/Indianapolis America/Indiana/Knox
  America/Indiana/Marengo America/Indiana/Petersburg America/Indiana/Tell_City
  America/Indiana/Vevay America/Indiana/Vincennes America/Indiana/Winamac America/Inuvik
  America/Iqaluit America/Jamaica America/Juneau America/Kentucky/Louisville
  America/Kentucky/Monticello America/Kralendijk America/La_Paz America/Lima America/Los_Angeles
  America/Lower_Princes America/Maceio America/Managua America/Manaus America/Marigot
  America/Martinique America/Matamoros America/Mazatlan America/Menominee America/Merida
  America/Metlakatla America/Mexico_City America/Miquelon America/Moncton America/Monterrey
  America/Montevideo America/Montserrat America/Nassau America/New_York America/Nome
  America/Noronha America/North_Dakota/Beulah America/North_Dakota/Center
  America/North_Dakota/New_Salem America/Nuuk America/Ojinaga America/Panama America/Paramaribo
  America/Phoenix America/Port-au-Prince America/Port_of_Spain America/Porto_Velho
  America/Puerto_Rico America/Punta_Arenas America/Rankin_Inlet America/Recife America/Regina
  America/Resolute America/Rio_Branco America/Santarem America/Santiago America/Santo_Domingo
  America/Sao_Paulo America/Scoresbysund America/Sitka America/St_Barthelemy America/St_Johns
  America/St_Kitts America/St_Lucia America/St_Thomas America/St_Vincent America/Swift_Current
  America/Tegucigalpa America/Thule America/Tijuana America/Toronto America/Tortola
  America/Vancouver America/Whitehorse America/Winnipeg America/Yakutat Antarctica/Casey
  Antarctica/Davis Antarctica/DumontDUrville Antarctica/Macquarie Antarctica/Mawson
  Antarctica/McMurdo Antarctica/Palmer Antarctica/Rothera Antarctica/Syowa Antarctica/Troll
  Antarctica/Vostok Arctic/Longyearbyen Asia/Aden Asia/Almaty Asia/Amman Asia/Anadyr Asia/Aqtau
  Asia/Aqtobe Asia/Ashgabat Asia/Atyrau Asia/Baghdad Asia/Bahrain Asia/Baku Asia/Bangkok
  Asia/Barnaul Asia/Beirut Asia/Bishkek Asia/Brunei Asia/Chita Asia/Colombo Asia/Damascus
  Asia/Dhaka Asia/Dili Asia/Dubai Asia/Dushanbe Asia/Famagusta Asia/Gaza Asia/Hebron
  Asia/Ho_Chi_Minh Asia/Hong_Kong Asia/Hovd Asia/Irkutsk Asia/Jakarta Asia/Jayapura
  Asia/Jerusalem Asia/Kabul Asia/Kamchatka Asia/Karachi Asia/Kathmandu Asia/Khandyga
  Asia/Kolkata Asia/Krasnoyarsk Asia/Kuala_Lumpur Asia/Kuching Asia/Kuwait Asia/Macau
  Asia/Magadan Asia/Makassar Asia/Manila Asia/Muscat Asia/Nicosia Asia/Novokuznetsk
  Asia/Novosibirsk Asia/Omsk Asia/Oral Asia/Phnom_Penh Asia/Pontianak Asia/Pyongyang Asia/Qatar
  Asia/Qostanay Asia/Qyzylorda Asia/Riyadh Asia/Sakhalin Asia/Samarkand Asia/Seoul Asia/Shanghai
  Asia/Singapore Asia/Srednekolymsk Asia/Taipei Asia/Tashkent Asia/Tbilisi Asia/Tehran
  Asia/Thimphu Asia/Tokyo Asia/Tomsk Asia/Ulaanbaatar Asia/Urumqi Asia/Ust-Nera Asia/Vientiane
  Asia/Vladivostok Asia/Yakutsk Asia/Yangon Asia/Yekaterinburg Asia/Yerevan Atlantic/Azores
  Atlantic/Bermuda Atlantic/Canary Atlantic/Cape_Verde Atlantic/Faroe Atlantic/Madeira
  Atlantic/Reykjavik Atlantic/South_Georgia Atlantic/St_Helena Atlantic/Stanley
  Australia/Adelaide Australia/Brisbane Australia/Broken_Hill Australia/Darwin Australia/Eucla
  Australia/Hobart Australia/Lindeman Australia/Lord_Howe Australia/Melbourne Australia/Perth
  Australia/Sydney CST6CDT EST5EDT Etc/GMT+1 Etc/GMT+10 Etc/GMT+11 Etc/GMT+12 Etc/GMT+2
  Etc/GMT+3 Etc/GMT+4 Etc/GMT+5 Etc/GMT+6 Etc/GMT+7 Etc/GMT+8 Etc/GMT+9 Etc/GMT-1 Etc/GMT-10
  Etc/GMT-11 Etc/GMT-12 Etc/GMT-13 Etc/GMT-14 Etc/GMT-2 Etc/GMT-3 Etc/GMT-4 Etc/GMT-5 Etc/GMT-6
  Etc/GMT-7 Etc/GMT-8 Etc/GMT-9 Europe/Amsterdam Europe/Andorra Europe/Astrakhan Europe/Athens
  Europe/Belgrade Europe/Berlin Europe/Bratislava Europe/Brussels Europe/Bucharest
  Europe/Budapest Europe/Busingen Europe/Chisinau Europe/Copenhagen Europe/Dublin
  Europe/Gibraltar Europe/Guernsey Europe/Helsinki Europe/Isle_of_Man Europe/Istanbul
  Europe/Jersey Europe/Kaliningrad Europe/Kirov Europe/Kyiv Europe/Lisbon Europe/Ljubljana
  Europe/London Europe/Luxembourg Europe/Madrid Europe/Malta Europe/Mariehamn Europe/Minsk
  Europe/Monaco Europe/Moscow Europe/Oslo Europe/Paris Europe/Podgorica Europe/Prague
  Europe/Riga Europe/Rome Europe/Samara Europe/San_Marino Europe/Sarajevo Europe/Saratov
  Europe/Simferopol Europe/Skopje Europe/Sofia Europe/Stockholm Europe/Tallinn Europe/Tirane
  Europe/Ulyanovsk Europe/Vaduz Europe/Vatican Europe/Vienna Europe/Vilnius Europe/Volgograd
  Europe/Warsaw Europe/Zagreb Europe/Zurich Indian/Antananarivo Indian/Chagos Indian/Christmas
  Indian/Cocos Indian/Comoro Indian/Kerguelen Indian/Mahe Indian/Maldives Indian/Mauritius
  Indian/Mayotte Indian/Reunion MST7MDT PST8PDT Pacific/Apia Pacific/Auckland
  Pacific/Bougainville Pacific/Chatham Pacific/Chuuk Pacific/Easter Pacific/Efate
  Pacific/Fakaofo Pacific/Fiji Pacific/Funafuti Pacific/Galapagos Pacific/Gambier
  Pacific/Guadalcanal Pacific/Guam Pacific/Honolulu Pacific/Kanton Pacific/Kiritimati
  Pacific/Kosrae Pacific/Kwajalein Pacific/Majuro Pacific/Marquesas Pacific/Midway Pacific/Nauru
  Pacific/Niue Pacific/Norfolk Pacific/Noumea Pacific/Pago_Pago Pacific/Palau Pacific/Pitcairn
  Pacific/Pohnpei Pacific/Port_Moresby Pacific/Rarotonga Pacific/Saipan Pacific/Tahiti
  Pacific/Tarawa Pacific/Tongatapu Pacific/Wake Pacific/Wallis SystemV/AST4 SystemV/AST4ADT
  SystemV/CST6 SystemV/CST6CDT SystemV/EST5 SystemV/EST5EDT SystemV/HST10 SystemV/MST7
  SystemV/MST7MDT SystemV/PST8 SystemV/PST8PDT SystemV/YST9 SystemV/YST9YDT UTC
`;

/** Alias → `canonicalTimeZone(alias)`. */
const ALIASES: Readonly<Record<string, string>> = {
  ACT: 'Australia/Darwin',
  AET: 'Australia/Sydney',
  AGT: 'America/Argentina/Buenos_Aires',
  ART: 'Africa/Cairo',
  AST: 'America/Anchorage',
  'Africa/Asmera': 'Africa/Asmara',
  'Africa/Timbuktu': 'Africa/Bamako',
  'America/Argentina/ComodRivadavia': 'America/Argentina/Catamarca',
  'America/Atikokan': 'America/Coral_Harbour',
  'America/Atka': 'America/Adak',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Ensenada': 'America/Tijuana',
  'America/Fort_Wayne': 'America/Indiana/Indianapolis',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Knox_IN': 'America/Indiana/Knox',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'America/Montreal': 'America/Toronto',
  'America/Nipigon': 'America/Toronto',
  'America/Pangnirtung': 'America/Iqaluit',
  'America/Porto_Acre': 'America/Rio_Branco',
  'America/Rainy_River': 'America/Winnipeg',
  'America/Rosario': 'America/Argentina/Cordoba',
  'America/Santa_Isabel': 'America/Tijuana',
  'America/Shiprock': 'America/Denver',
  'America/Thunder_Bay': 'America/Toronto',
  'America/Virgin': 'America/St_Thomas',
  'America/Yellowknife': 'America/Edmonton',
  'Antarctica/South_Pole': 'Antarctica/McMurdo',
  'Asia/Ashkhabad': 'Asia/Ashgabat',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Choibalsan': 'Asia/Ulaanbaatar',
  'Asia/Chongqing': 'Asia/Shanghai',
  'Asia/Chungking': 'Asia/Shanghai',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Harbin': 'Asia/Shanghai',
  'Asia/Istanbul': 'Europe/Istanbul',
  'Asia/Kashgar': 'Asia/Urumqi',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Macao': 'Asia/Macau',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Tel_Aviv': 'Asia/Jerusalem',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Ujung_Pandang': 'Asia/Makassar',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Atlantic/Jan_Mayen': 'Arctic/Longyearbyen',
  'Australia/ACT': 'Australia/Sydney',
  'Australia/Canberra': 'Australia/Sydney',
  'Australia/Currie': 'Australia/Hobart',
  'Australia/LHI': 'Australia/Lord_Howe',
  'Australia/NSW': 'Australia/Sydney',
  'Australia/North': 'Australia/Darwin',
  'Australia/Queensland': 'Australia/Brisbane',
  'Australia/South': 'Australia/Adelaide',
  'Australia/Tasmania': 'Australia/Hobart',
  'Australia/Victoria': 'Australia/Melbourne',
  'Australia/West': 'Australia/Perth',
  'Australia/Yancowinna': 'Australia/Broken_Hill',
  BET: 'America/Sao_Paulo',
  BST: 'Asia/Dhaka',
  'Brazil/Acre': 'America/Rio_Branco',
  'Brazil/DeNoronha': 'America/Noronha',
  'Brazil/East': 'America/Sao_Paulo',
  'Brazil/West': 'America/Manaus',
  CAT: 'Africa/Maputo',
  CET: 'Europe/Brussels',
  CNT: 'America/St_Johns',
  CST: 'America/Chicago',
  CTT: 'Asia/Shanghai',
  'Canada/Atlantic': 'America/Halifax',
  'Canada/Central': 'America/Winnipeg',
  'Canada/East-Saskatchewan': 'America/Regina',
  'Canada/Eastern': 'America/Toronto',
  'Canada/Mountain': 'America/Edmonton',
  'Canada/Newfoundland': 'America/St_Johns',
  'Canada/Pacific': 'America/Vancouver',
  'Canada/Saskatchewan': 'America/Regina',
  'Canada/Yukon': 'America/Whitehorse',
  'Chile/Continental': 'America/Santiago',
  'Chile/EasterIsland': 'Pacific/Easter',
  Cuba: 'America/Havana',
  EAT: 'Africa/Nairobi',
  ECT: 'Europe/Paris',
  EET: 'Europe/Athens',
  EST: 'America/Panama',
  Egypt: 'Africa/Cairo',
  Eire: 'Europe/Dublin',
  'Etc/GMT': 'UTC',
  'Etc/GMT+0': 'UTC',
  'Etc/GMT-0': 'UTC',
  'Etc/GMT0': 'UTC',
  'Etc/Greenwich': 'UTC',
  'Etc/UCT': 'UTC',
  'Etc/UTC': 'UTC',
  'Etc/Universal': 'UTC',
  'Etc/Zulu': 'UTC',
  'Europe/Belfast': 'Europe/London',
  'Europe/Kiev': 'Europe/Kyiv',
  'Europe/Nicosia': 'Asia/Nicosia',
  'Europe/Tiraspol': 'Europe/Chisinau',
  'Europe/Uzhgorod': 'Europe/Kyiv',
  'Europe/Zaporozhye': 'Europe/Kyiv',
  GB: 'Europe/London',
  'GB-Eire': 'Europe/London',
  GMT: 'UTC',
  'GMT+0': 'UTC',
  'GMT-0': 'UTC',
  GMT0: 'UTC',
  Greenwich: 'UTC',
  HST: 'Pacific/Honolulu',
  Hongkong: 'Asia/Hong_Kong',
  IET: 'America/Indiana/Indianapolis',
  IST: 'Asia/Kolkata',
  Iceland: 'Atlantic/Reykjavik',
  Iran: 'Asia/Tehran',
  Israel: 'Asia/Jerusalem',
  JST: 'Asia/Tokyo',
  Jamaica: 'America/Jamaica',
  Japan: 'Asia/Tokyo',
  Kwajalein: 'Pacific/Kwajalein',
  Libya: 'Africa/Tripoli',
  MET: 'Europe/Brussels',
  MIT: 'Pacific/Apia',
  MST: 'America/Phoenix',
  'Mexico/BajaNorte': 'America/Tijuana',
  'Mexico/BajaSur': 'America/Mazatlan',
  'Mexico/General': 'America/Mexico_City',
  NET: 'Asia/Yerevan',
  NST: 'Pacific/Auckland',
  NZ: 'Pacific/Auckland',
  'NZ-CHAT': 'Pacific/Chatham',
  Navajo: 'America/Denver',
  PLT: 'Asia/Karachi',
  PNT: 'America/Phoenix',
  PRC: 'Asia/Shanghai',
  PRT: 'America/Puerto_Rico',
  PST: 'America/Los_Angeles',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Johnston': 'Pacific/Honolulu',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Samoa': 'Pacific/Pago_Pago',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Yap': 'Pacific/Chuuk',
  Poland: 'Europe/Warsaw',
  Portugal: 'Europe/Lisbon',
  ROC: 'Asia/Taipei',
  ROK: 'Asia/Seoul',
  SST: 'Pacific/Guadalcanal',
  Singapore: 'Asia/Singapore',
  Turkey: 'Europe/Istanbul',
  UCT: 'UTC',
  'US/Alaska': 'America/Anchorage',
  'US/Aleutian': 'America/Adak',
  'US/Arizona': 'America/Phoenix',
  'US/Central': 'America/Chicago',
  'US/East-Indiana': 'America/Indiana/Indianapolis',
  'US/Eastern': 'America/New_York',
  'US/Hawaii': 'Pacific/Honolulu',
  'US/Indiana-Starke': 'America/Indiana/Knox',
  'US/Michigan': 'America/Detroit',
  'US/Mountain': 'America/Denver',
  'US/Pacific': 'America/Los_Angeles',
  'US/Pacific-New': 'America/Los_Angeles',
  'US/Samoa': 'Pacific/Pago_Pago',
  Universal: 'UTC',
  VST: 'Asia/Ho_Chi_Minh',
  'W-SU': 'Europe/Moscow',
  WET: 'Europe/Lisbon',
  Zulu: 'UTC',
};

const ZONES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    CANONICAL_NAMES.split(/\s+/)
      .filter((name) => name !== '')
      .map((name) => [name, name]),
  ),
  ...ALIASES,
};

/**
 * One statement; a DO block takes no parameters, so the map comes in a
 * transaction-local setting (the migrator runs every migration in one
 * transaction). `zones`: lower-cased name → IANA primary name.
 */
const REWRITE = `DO $$
DECLARE
  zones jsonb := (
    SELECT jsonb_object_agg(lower(key), value)
      FROM jsonb_each_text(current_setting('cellhive.time_zones')::jsonb)
  );
  unknown_count bigint;
BEGIN
  UPDATE meta.users SET timezone = zones ->> lower(timezone)
   WHERE timezone <> zones ->> lower(timezone);

  UPDATE meta.organizations
     SET settings = jsonb_set(settings, '{timezone}', to_jsonb(zones ->> lower(settings ->> 'timezone')))
   WHERE jsonb_typeof(settings -> 'timezone') = 'string'
     AND settings ->> 'timezone' <> zones ->> lower(settings ->> 'timezone');

  UPDATE meta.bases
     SET settings = jsonb_set(settings, '{timezone}', to_jsonb(zones ->> lower(settings ->> 'timezone')))
   WHERE jsonb_typeof(settings -> 'timezone') = 'string'
     AND settings ->> 'timezone' <> zones ->> lower(settings ->> 'timezone');

  UPDATE meta.fields
     SET options = jsonb_set(options, '{timezone}', to_jsonb(zones ->> lower(options ->> 'timezone')))
   WHERE jsonb_typeof(options -> 'timezone') = 'string'
     AND options ->> 'timezone' <> zones ->> lower(options ->> 'timezone');

  -- Only the schedule trigger has a zone.
  UPDATE meta.automations
     SET definition = jsonb_set(definition, '{trigger,timezone}',
                                to_jsonb(zones ->> lower(definition #>> '{trigger,timezone}')))
   WHERE jsonb_typeof(definition #> '{trigger,timezone}') = 'string'
     AND definition #>> '{trigger,timezone}' <> zones ->> lower(definition #>> '{trigger,timezone}');

  SELECT count(*) INTO unknown_count
    FROM (
      SELECT timezone AS zone FROM meta.users
      UNION ALL
      SELECT settings ->> 'timezone' FROM meta.organizations
       WHERE jsonb_typeof(settings -> 'timezone') = 'string'
      UNION ALL
      SELECT settings ->> 'timezone' FROM meta.bases
       WHERE jsonb_typeof(settings -> 'timezone') = 'string'
      UNION ALL
      SELECT options ->> 'timezone' FROM meta.fields
       WHERE jsonb_typeof(options -> 'timezone') = 'string'
      UNION ALL
      SELECT definition #>> '{trigger,timezone}' FROM meta.automations
       WHERE jsonb_typeof(definition #> '{trigger,timezone}') = 'string'
    ) AS stored
   WHERE zone IS NOT NULL AND NOT zones ? lower(zone);
  IF unknown_count > 0 THEN
    RAISE WARNING 'migration 0055_canonical_time_zones: % stored time zone value(s) are not a known zone name, left unchanged', unknown_count;
  END IF;
END
$$`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SELECT set_config('cellhive.time_zones', ${JSON.stringify(ZONES)}, true)`.execute(db);
  // Static SQL: no value in this statement comes from input.
  await sql.raw(REWRITE).execute(db);
}
