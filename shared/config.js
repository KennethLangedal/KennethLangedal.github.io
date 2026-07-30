/* Where the solver lives.

   One listener per variant, reached by path: /maxi, /yatzy, /yahtzee. This is
   the only place the address appears, so moving the server to a different host
   or to a domain name is a one-line change here. */

const SOLVER_HOST = 'https://89.167.37.171';
