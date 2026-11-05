$title Mini Shipping Problem (original QA fixture)
$onText
Two depots, two shops; original model written for tests.
$offText
Sets
   d 'depots' / north, south /
   s 'shops'  / east, west /;

Parameters
   stock(d) 'units available' / north 90, south 60 /
   need(s)  'units wanted'    / east 70, west 50 /;

Table fee(d,s) 'cost per unit'
          east  west
   north  2.5   1.75
   south  1.9   2.6 ;

Variables
   flow(d,s) 'units shipped'
   total     'total cost';
Positive Variable flow;

Equations
   obj        'cost definition'
   cap(d)     'depot capacity'
   dem(s)     'shop demand';

obj..   total =e= sum((d,s), fee(d,s)*flow(d,s));
cap(d).. sum(s, flow(d,s)) =l= stock(d);
dem(s).. sum(d, flow(d,s)) =g= need(s);

Model ship / all /;
Solve ship using lp minimizing total;
Display flow.l, total.l;
