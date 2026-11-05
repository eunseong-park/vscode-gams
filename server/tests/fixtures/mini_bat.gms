$title Mini Shipping Problem, $batinclude variant
Sets
   d 'depots' / north, south /
   s 'shops'  / east, west /;
$include mini_data.inc
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
$batinclude mini_rep.inc d depot s
Display flow.l, total.l;
