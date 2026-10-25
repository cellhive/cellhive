import { implementation as ABS } from '../functions/ABS.js';
import { implementation as AND } from '../functions/AND.js';
import { implementation as ARRAYJOIN } from '../functions/ARRAYJOIN.js';
import { implementation as AVERAGE } from '../functions/AVERAGE.js';
import { implementation as CEILING } from '../functions/CEILING.js';
import { implementation as CONCATENATE } from '../functions/CONCATENATE.js';
import { implementation as CONTAIN } from '../functions/CONTAIN.js';
import { implementation as CONTAINSALL } from '../functions/CONTAINSALL.js';
import { implementation as CONTAINSONLY } from '../functions/CONTAINSONLY.js';
import { implementation as CONTAINTEXT } from '../functions/CONTAINTEXT.js';
import { implementation as COUNTA } from '../functions/COUNTA.js';
import { implementation as COUNTIF } from '../functions/COUNTIF.js';
import { implementation as DATE } from '../functions/DATE.js';
import { implementation as DATEDIF } from '../functions/DATEDIF.js';
import { implementation as DAY } from '../functions/DAY.js';
import { implementation as DAYS } from '../functions/DAYS.js';
import { implementation as DURATION } from '../functions/DURATION.js';
import { implementation as EDATE } from '../functions/EDATE.js';
import { implementation as ENCODEURL } from '../functions/ENCODEURL.js';
import { implementation as EOMONTH } from '../functions/EOMONTH.js';
import { implementation as EXP } from '../functions/EXP.js';
import { implementation as FALSE } from '../functions/FALSE.js';
import { implementation as FILTER } from '../functions/FILTER.js';
import { implementation as FIND } from '../functions/FIND.js';
import { implementation as FIRST } from '../functions/FIRST.js';
import { implementation as FLOOR } from '../functions/FLOOR.js';
import { implementation as FORMAT } from '../functions/FORMAT.js';
import { implementation as HOUR } from '../functions/HOUR.js';
import { implementation as HYPERLINK } from '../functions/HYPERLINK.js';
import { implementation as IF } from '../functions/IF.js';
import { implementation as IFBLANK } from '../functions/IFBLANK.js';
import { implementation as IFERROR } from '../functions/IFERROR.js';
import { implementation as IFS } from '../functions/IFS.js';
import { implementation as INT } from '../functions/INT.js';
import { implementation as ISBLANK } from '../functions/ISBLANK.js';
import { implementation as ISERROR } from '../functions/ISERROR.js';
import { implementation as ISNULL } from '../functions/ISNULL.js';
import { implementation as ISNUMBER } from '../functions/ISNUMBER.js';
import { implementation as LARGE } from '../functions/LARGE.js';
import { implementation as LAST } from '../functions/LAST.js';
import { implementation as LEFT } from '../functions/LEFT.js';
import { implementation as LEN } from '../functions/LEN.js';
import { implementation as LIST } from '../functions/LIST.js';
import { implementation as LISTCOMBINE } from '../functions/LISTCOMBINE.js';
import { implementation as LN } from '../functions/LN.js';
import { implementation as LOG } from '../functions/LOG.js';
import { implementation as LOOKUP } from '../functions/LOOKUP.js';
import { implementation as LOWER } from '../functions/LOWER.js';
import { implementation as MAP } from '../functions/MAP.js';
import { implementation as MAX } from '../functions/MAX.js';
import { implementation as MEDIAN } from '../functions/MEDIAN.js';
import { implementation as MID } from '../functions/MID.js';
import { implementation as MIN } from '../functions/MIN.js';
import { implementation as MINUTE } from '../functions/MINUTE.js';
import { implementation as MOD } from '../functions/MOD.js';
import { implementation as MONTH } from '../functions/MONTH.js';
import { implementation as NETWORKDAYS } from '../functions/NETWORKDAYS.js';
import { implementation as NOT } from '../functions/NOT.js';
import { implementation as NOW } from '../functions/NOW.js';
import { implementation as NTH } from '../functions/NTH.js';
import { implementation as OR } from '../functions/OR.js';
import { implementation as PI } from '../functions/PI.js';
import { implementation as POWER } from '../functions/POWER.js';
import { implementation as PRODUCT } from '../functions/PRODUCT.js';
import { implementation as QUOTIENT } from '../functions/QUOTIENT.js';
import { implementation as RANK } from '../functions/RANK.js';
import { implementation as RECORD_ID } from '../functions/RECORD_ID.js';
import { implementation as REGEXEXTRACT } from '../functions/REGEXEXTRACT.js';
import { implementation as REGEXMATCH } from '../functions/REGEXMATCH.js';
import { implementation as REGEXREPLACE } from '../functions/REGEXREPLACE.js';
import { implementation as REPLACE } from '../functions/REPLACE.js';
import { implementation as RIGHT } from '../functions/RIGHT.js';
import { implementation as ROUND } from '../functions/ROUND.js';
import { implementation as ROUNDDOWN } from '../functions/ROUNDDOWN.js';
import { implementation as ROUNDUP } from '../functions/ROUNDUP.js';
import { implementation as SECOND } from '../functions/SECOND.js';
import { implementation as SMALL } from '../functions/SMALL.js';
import { implementation as SORT } from '../functions/SORT.js';
import { implementation as SORTBY } from '../functions/SORTBY.js';
import { implementation as SPLIT } from '../functions/SPLIT.js';
import { implementation as SQRT } from '../functions/SQRT.js';
import { implementation as STDEV } from '../functions/STDEV.js';
import { implementation as SUBSTITUTE } from '../functions/SUBSTITUTE.js';
import { implementation as SUM } from '../functions/SUM.js';
import { implementation as SUMIF } from '../functions/SUMIF.js';
import { implementation as SWITCH } from '../functions/SWITCH.js';
import { implementation as TEXT } from '../functions/TEXT.js';
import { implementation as TODATE } from '../functions/TODATE.js';
import { implementation as TODAY } from '../functions/TODAY.js';
import { implementation as TRIM } from '../functions/TRIM.js';
import { implementation as TRUE } from '../functions/TRUE.js';
import { implementation as UNACCENT } from '../functions/UNACCENT.js';
import { implementation as UNIQUE } from '../functions/UNIQUE.js';
import { implementation as UPPER } from '../functions/UPPER.js';
import { implementation as VALUE } from '../functions/VALUE.js';
import { implementation as WEEKDAY } from '../functions/WEEKDAY.js';
import { implementation as WEEKNUM } from '../functions/WEEKNUM.js';
import { implementation as WORKDAY } from '../functions/WORKDAY.js';
import { implementation as YEAR } from '../functions/YEAR.js';

import type { FunctionImpl } from './runtime.js';
import type { FunctionName } from '../function-names.js';

/**
 * TS implementation of every catalogue function (T453), by name. `LET` is
 * syntax (its own AST node), not a call.
 */
export const IMPLEMENTATIONS: Readonly<Record<Exclude<FunctionName, 'LET'>, FunctionImpl>> = {
  ABS,
  AND,
  ARRAYJOIN,
  AVERAGE,
  CEILING,
  CONCATENATE,
  CONTAIN,
  CONTAINSALL,
  CONTAINSONLY,
  CONTAINTEXT,
  COUNTA,
  COUNTIF,
  DATE,
  DATEDIF,
  DAY,
  DAYS,
  DURATION,
  EDATE,
  ENCODEURL,
  EOMONTH,
  EXP,
  FALSE,
  FILTER,
  FIND,
  FIRST,
  FLOOR,
  FORMAT,
  HOUR,
  HYPERLINK,
  IF,
  IFBLANK,
  IFERROR,
  IFS,
  INT,
  ISBLANK,
  ISERROR,
  ISNULL,
  ISNUMBER,
  LARGE,
  LAST,
  LEFT,
  LEN,
  LIST,
  LISTCOMBINE,
  LN,
  LOG,
  LOOKUP,
  LOWER,
  MAP,
  MAX,
  MEDIAN,
  MID,
  MIN,
  MINUTE,
  MOD,
  MONTH,
  NETWORKDAYS,
  NOT,
  NOW,
  NTH,
  OR,
  PI,
  POWER,
  PRODUCT,
  QUOTIENT,
  RANK,
  RECORD_ID,
  REGEXEXTRACT,
  REGEXMATCH,
  REGEXREPLACE,
  REPLACE,
  RIGHT,
  ROUND,
  ROUNDDOWN,
  ROUNDUP,
  SECOND,
  SMALL,
  SORT,
  SORTBY,
  SPLIT,
  SQRT,
  STDEV,
  SUBSTITUTE,
  SUM,
  SUMIF,
  SWITCH,
  TEXT,
  TODATE,
  TODAY,
  TRIM,
  TRUE,
  UNACCENT,
  UNIQUE,
  UPPER,
  VALUE,
  WEEKDAY,
  WEEKNUM,
  WORKDAY,
  YEAR,
};
